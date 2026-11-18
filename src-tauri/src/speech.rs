use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

const ENDPOINT: &str = "https://api.speechify.ai/v1/audio/stream/with-timestamps";
// Bumped when the voice settings change, so older cached audio is not reused.
const POLICY: &str = "athens-speech-v1";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Mark {
    pub start: usize,
    pub end: usize,
    pub start_time: f64,
}

#[derive(Serialize)]
pub struct Speech {
    audio: String,
    marks: Vec<Mark>,
}

#[derive(Deserialize)]
struct Event {
    r#type: Option<String>,
    audio: Option<String>,
    speech_marks: Option<Vec<Mark>>,
    error: Option<EventError>,
}

#[derive(Deserialize)]
struct EventError {
    code: Option<String>,
    message: Option<String>,
}

struct Voice {
    id: String,
    model: String,
    language: &'static str,
}

// Dominic on simba-3.0 is the voice used by the OpenCode read-aloud plugin.
// German text uses Henrik, which that plugin also switches to.
fn voice(language: &str) -> Voice {
    if language == "de" {
        return Voice {
            id: "henrik-agent".into(),
            model: "simba-3.0".into(),
            language: "de-DE",
        };
    }
    Voice {
        id: std::env::var("SPEECHIFY_VOICE_ID").unwrap_or_else(|_| "dominic".into()),
        model: std::env::var("SPEECHIFY_MODEL_ID").unwrap_or_else(|_| "simba-3.0".into()),
        language: "en-US",
    }
}

fn key_files(app: &AppHandle) -> Vec<PathBuf> {
    let mut files = Vec::new();
    if let Ok(dir) = app.path().app_data_dir() {
        files.push(dir.join("speechify.key"));
    }
    // The OpenCode read-aloud plugin keeps its key here.
    let data = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")));
    if let Some(data) = data {
        files.push(data.join("opencode").join("speechify.key"));
    }
    files
}

fn api_key(app: &AppHandle) -> Result<String, String> {
    if let Ok(key) = std::env::var("SPEECHIFY_API_KEY") {
        if !key.trim().is_empty() {
            return Ok(key.trim().to_string());
        }
    }
    let files = key_files(app);
    for file in &files {
        if let Ok(key) = fs::read_to_string(file) {
            if !key.trim().is_empty() {
                return Ok(key.trim().to_string());
            }
        }
    }
    let first = files
        .first()
        .map(|file| file.display().to_string())
        .unwrap_or_else(|| "the app data folder".into());
    Err(format!(
        "Add a Speechify API key: write it to {first} or set SPEECHIFY_API_KEY"
    ))
}

fn cache_paths(dir: &Path, voice: &Voice, text: &str) -> (PathBuf, PathBuf) {
    let mut hash = Sha256::new();
    hash.update(format!(
        "{POLICY}\0{}\0{}\0{}\0{text}",
        voice.id, voice.model, voice.language
    ));
    let id: String = hash
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    (dir.join(format!("{id}.mp3")), dir.join(format!("{id}.json")))
}

/// Speechify streams server-sent events: base64 mp3 chunks and, per word, a
/// speech mark with its code point range and start time in milliseconds.
pub fn parse_stream(body: &str) -> Result<(Vec<u8>, Vec<Mark>), String> {
    let mut audio = Vec::new();
    let mut marks = Vec::new();
    let mut done = false;
    for line in body.lines() {
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let event: Event = serde_json::from_str(data.trim())
            .map_err(|error| format!("Speechify sent an unreadable event: {error}"))?;
        match event.r#type.as_deref() {
            Some("speech.error") => {
                let error = event.error;
                return Err(format!(
                    "Speechify {}: {}",
                    error
                        .as_ref()
                        .and_then(|e| e.code.clone())
                        .unwrap_or_default(),
                    error.and_then(|e| e.message).unwrap_or_default()
                ));
            }
            Some("speech.done") => done = true,
            _ => {}
        }
        if let Some(chunk) = event.audio {
            audio.extend(
                STANDARD
                    .decode(chunk)
                    .map_err(|error| format!("Speechify sent invalid audio: {error}"))?,
            );
        }
        marks.extend(event.speech_marks.unwrap_or_default());
    }
    if !done {
        return Err("Speechify stream ended before speech.done".into());
    }
    if audio.is_empty() {
        return Err("Speechify returned no audio".into());
    }
    Ok((audio, marks))
}

#[tauri::command]
pub async fn speech_synthesize(
    app: AppHandle,
    text: String,
    language: String,
) -> Result<Speech, String> {
    let voice = voice(&language);
    let cache = app.path().app_cache_dir().ok().map(|dir| dir.join("speech"));
    let paths = cache.as_ref().map(|dir| cache_paths(dir, &voice, &text));
    if let Some((audio, meta)) = &paths {
        if let (Ok(bytes), Ok(marks)) = (fs::read(audio), fs::read(meta)) {
            if let Ok(marks) = serde_json::from_slice::<Vec<Mark>>(&marks) {
                return Ok(Speech {
                    audio: STANDARD.encode(bytes),
                    marks,
                });
            }
        }
    }

    let key = api_key(&app)?;
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .post(ENDPOINT)
        .bearer_auth(key)
        .header("content-type", "application/json")
        .body(
            serde_json::json!({
                "input": text,
                "voice_id": voice.id,
                "model": voice.model,
                "language": voice.language,
                // Streaming only offers 24 kHz mp3 at most.
                "output_format": "mp3_24000_128",
            })
            .to_string(),
        )
        .send()
        .await
        .map_err(|error| format!("Could not reach Speechify: {error}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("Speechify response failed: {error}"))?;
    if !status.is_success() {
        return Err(format!("Speechify {}: {}", status.as_u16(), body));
    }
    let (audio, marks) = parse_stream(&body)?;

    if let (Some(dir), Some((audio_path, meta_path))) = (&cache, &paths) {
        if fs::create_dir_all(dir).is_ok() {
            let _ = fs::write(audio_path, &audio);
            if let Ok(meta) = serde_json::to_vec(&marks) {
                let _ = fs::write(meta_path, meta);
            }
        }
    }
    Ok(Speech {
        audio: STANDARD.encode(audio),
        marks,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(json: &str) -> String {
        format!("event: message\ndata: {json}\n\n")
    }

    #[test]
    fn joins_audio_chunks_and_keeps_word_marks() {
        let body = [
            event(r#"{"type":"speech.chunk","audio":"AQID","speech_marks":[{"start":0,"end":5,"start_time":0.0}]}"#),
            event(r#"{"type":"speech.chunk","audio":"BAU=","speech_marks":[{"start":6,"end":11,"start_time":420.5}]}"#),
            event(r#"{"type":"speech.done"}"#),
        ]
        .concat();
        let (audio, marks) = parse_stream(&body).unwrap();
        assert_eq!(audio, vec![1, 2, 3, 4, 5]);
        assert_eq!(marks.len(), 2);
        assert_eq!((marks[1].start, marks[1].end, marks[1].start_time), (6, 11, 420.5));
    }

    #[test]
    fn reports_service_errors_and_truncated_streams() {
        let error = event(r#"{"type":"speech.error","error":{"code":"quota","message":"No characters left"}}"#);
        assert_eq!(parse_stream(&error).unwrap_err(), "Speechify quota: No characters left");
        let truncated = event(r#"{"type":"speech.chunk","audio":"AQID"}"#);
        assert!(parse_stream(&truncated).unwrap_err().contains("before speech.done"));
    }

    #[test]
    fn cache_key_depends_on_voice_language_and_text() {
        let dir = Path::new("/cache");
        let en = voice("en");
        let de = voice("de");
        let (a, _) = cache_paths(dir, &en, "Hello");
        assert_eq!(a, cache_paths(dir, &en, "Hello").0);
        assert_ne!(a, cache_paths(dir, &en, "Hello!").0);
        assert_ne!(a, cache_paths(dir, &de, "Hello").0);
    }
}
