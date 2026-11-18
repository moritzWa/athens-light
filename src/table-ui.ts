import type { Editor } from "@tiptap/core";
import { TextSelection, type Transaction } from "@tiptap/pm/state";
import { closeHistory } from "@tiptap/pm/history";
import { CellSelection, TableMap, deleteCellSelection, moveTableColumn, moveTableRow, selectedRect } from "@tiptap/pm/tables";
import "./table-ui.css";

type Kind = "column" | "row";
const CELLS = "td, th";

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, label?: string) {
  const node = document.createElement(tag);
  node.className = className;
  if (label) node.setAttribute("aria-label", label), node.title = label;
  if (node instanceof HTMLButtonElement) {
    node.type = "button";
    node.addEventListener("mousedown", event => event.preventDefault());
  }
  return node;
}

export function mountTableControls(editor: Editor) {
  const root = editor.view.dom;
  const layer = element("div", "table-controls");
  const columnGrip = element("button", "table-grip table-grip-column", "Column options");
  const rowGrip = element("button", "table-grip table-grip-row", "Row options");
  const addColumn = element("button", "table-add table-add-column", "Add column");
  const addRow = element("button", "table-add table-add-row", "Add row");
  columnGrip.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="12.5" cy="8" r="1.4"/></svg>';
  rowGrip.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="3.5" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="8" cy="12.5" r="1.4"/></svg>';
  addColumn.textContent = "+";
  addRow.textContent = "+";
  const menu = element("div", "table-menu");
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  layer.append(columnGrip, rowGrip, addColumn, addRow, menu);
  layer.hidden = true;
  document.body.append(layer);

  let hovered: HTMLTableCellElement | null = null;
  let active: HTMLTableCellElement | null = null;
  let menuKind: Kind | null = null;
  let pressing = false;
  let frame = 0;
  let leaveTimer: number | undefined;

  const schedule = () => { if (!frame) frame = window.requestAnimationFrame(update); };

  function cellPosition(cell: Element) {
    const $pos = editor.state.doc.resolve(editor.view.posAtDOM(cell, 0));
    for (let depth = $pos.depth; depth > 0; depth--) {
      const role = $pos.node(depth).type.spec.tableRole;
      if (role === "cell" || role === "header_cell") return $pos.before(depth);
    }
    return null;
  }
  function selectionCell() {
    const selection = editor.state.selection;
    const pos = selection instanceof CellSelection ? selection.$anchorCell.pos : (() => {
      for (let depth = selection.$from.depth; depth > 0; depth--) {
        const role = selection.$from.node(depth).type.spec.tableRole;
        if (role === "cell" || role === "header_cell") return selection.$from.before(depth);
      }
      return null;
    })();
    if (pos === null) return null;
    const node = editor.view.nodeDOM(pos);
    return node instanceof HTMLTableCellElement ? node : null;
  }
  function tableOf(cell: Element) {
    const table = cell.closest("table");
    return table && root.contains(table) ? table : null;
  }

  function closeMenu() {
    menu.hidden = true;
    menuKind = null;
    columnGrip.setAttribute("aria-expanded", "false");
    rowGrip.setAttribute("aria-expanded", "false");
    columnGrip.classList.remove("open");
    rowGrip.classList.remove("open");
    menu.replaceChildren();
  }

  function collapse() {
    const selection = editor.state.selection;
    if (!(selection instanceof CellSelection)) return;
    try { editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(selection.$anchorCell.pos + 1)))); } catch { /* The anchor cell was deleted. */ }
  }
  function run(action: () => unknown) {
    if (!editor.isEditable) return;
    closeMenu();
    editor.view.dispatch(closeHistory(editor.state.tr));
    action();
    collapse();
    editor.view.dispatch(closeHistory(editor.state.tr));
    editor.view.focus();
    schedule();
  }
  function selectCell(cell: HTMLTableCellElement) {
    const pos = cellPosition(cell);
    if (pos === null) return false;
    editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(editor.state.doc, pos)));
    return true;
  }
  function selectLine(cell: HTMLTableCellElement, kind: Kind) {
    const pos = cellPosition(cell);
    if (pos === null) return false;
    const $cell = editor.state.doc.resolve(pos);
    editor.view.dispatch(editor.state.tr.setSelection(kind === "column" ? CellSelection.colSelection($cell) : CellSelection.rowSelection($cell)));
    return true;
  }
  function resetWidths(cell: HTMLTableCellElement) {
    const pos = cellPosition(cell);
    if (pos === null) return;
    const $cell = editor.state.doc.resolve(pos);
    for (let depth = $cell.depth; depth > 0; depth--) {
      if ($cell.node(depth).type.spec.tableRole !== "table") continue;
      const tr = editor.state.tr;
      const start = $cell.start(depth);
      $cell.node(depth).descendants((node, offset) => {
        const role = node.type.spec.tableRole;
        if (role === "cell" || role === "header_cell") { if (node.attrs.colwidth) tr.setNodeMarkup(start + offset, null, { ...node.attrs, colwidth: null }); return false; }
        return true;
      });
      editor.view.dispatch(tr);
      return;
    }
  }
  function hasCustomWidths(cell: HTMLTableCellElement) {
    const table = tableOf(cell);
    return !!table && [...table.querySelectorAll("col")].some(col => (col as HTMLElement).style.width);
  }
  function isHeaderRow(cell: HTMLTableCellElement) {
    return cell.parentElement === tableOf(cell)?.querySelector("tr");
  }

  function item(label: string, action: () => unknown, enabled = true) {
    const button = element("button", "table-menu-item");
    button.textContent = label;
    button.setAttribute("role", "menuitem");
    button.disabled = !enabled;
    button.addEventListener("click", () => run(action));
    menu.append(button);
  }
  function separator() {
    const line = element("div", "table-menu-separator");
    line.setAttribute("role", "separator");
    menu.append(line);
  }
  function move(kind: Kind, direction: -1 | 1) {
    const rect = selectedRect(editor.state);
    const from = kind === "column" ? rect.left : rect.top;
    const to = from + direction;
    const options = { from, to, select: false };
    return editor.commands.command(({ state, dispatch }) => (kind === "column" ? moveTableColumn(options) : moveTableRow(options))(state, dispatch));
  }
  function canMove(kind: Kind, direction: -1 | 1) {
    const rect = selectedRect(editor.state);
    const index = kind === "column" ? rect.left : rect.top;
    const size = kind === "column" ? rect.map.width : rect.map.height;
    const target = index + direction;
    // Row 0 is the Markdown header row, so nothing swaps with it.
    const first = kind === "row" ? 1 : 0;
    return index >= first && target >= first && target < size;
  }
  function openMenu(kind: Kind, grip: HTMLElement) {
    if (!active || !editor.isEditable) return;
    const cell = active;
    if (menuKind === kind) { closeMenu(); return; }
    closeMenu();
    if (!selectLine(cell, kind)) return;
    menuKind = kind;
    grip.setAttribute("aria-expanded", "true");
    grip.classList.add("open");
    menu.setAttribute("aria-label", kind === "column" ? "Column options" : "Row options");
    if (kind === "column") {
      item("Insert column left", () => editor.commands.addColumnBefore(), editor.can().addColumnBefore());
      item("Insert column right", () => editor.commands.addColumnAfter(), editor.can().addColumnAfter());
      separator();
      item("Move column left", () => move("column", -1), canMove("column", -1));
      item("Move column right", () => move("column", 1), canMove("column", 1));
      separator();
      item("Align left", () => editor.commands.setCellAttribute("align", null));
      item("Align center", () => editor.commands.setCellAttribute("align", "center"));
      item("Align right", () => editor.commands.setCellAttribute("align", "right"));
      separator();
      item("Clear contents", () => editor.commands.command(({ state, dispatch }) => deleteCellSelection(state, dispatch)));
      if (hasCustomWidths(cell)) item("Reset column widths", () => resetWidths(cell));
      item("Delete column", () => editor.commands.deleteColumn(), editor.can().deleteColumn());
    } else {
      item("Insert row above", () => editor.commands.addRowBefore(), editor.can().addRowBefore() && !isHeaderRow(cell));
      item("Insert row below", () => editor.commands.addRowAfter(), editor.can().addRowAfter());
      separator();
      item("Move row up", () => move("row", -1), canMove("row", -1));
      item("Move row down", () => move("row", 1), canMove("row", 1));
      separator();
      item("Clear contents", () => editor.commands.command(({ state, dispatch }) => deleteCellSelection(state, dispatch)));
      item("Delete row", () => editor.commands.deleteRow(), editor.can().deleteRow());
    }
    separator();
    item("Delete table", () => editor.commands.deleteTable(), editor.can().deleteTable());
    menu.hidden = false;
    placeMenu(grip, kind);
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
  }
  function placeMenu(grip: HTMLElement, kind: Kind) {
    const rect = grip.getBoundingClientRect();
    const width = menu.offsetWidth, height = menu.offsetHeight;
    const left = kind === "column" ? rect.left : rect.right + 6;
    const top = kind === "column" ? rect.bottom + 6 : rect.top;
    menu.style.left = `${Math.max(12, Math.min(left, window.innerWidth - width - 12))}px`;
    menu.style.top = `${Math.max(44, Math.min(top, window.innerHeight - height - 12))}px`;
  }

  function addAtEnd(kind: Kind, cell: HTMLTableCellElement) {
    const table = tableOf(cell);
    const start = table ? cellPosition(table.querySelector(CELLS)!) : null;
    if (!table || start === null) return;
    const $first = editor.state.doc.resolve(start);
    let tableDepth = $first.depth;
    while (tableDepth > 0 && $first.node(tableDepth).type.spec.tableRole !== "table") tableDepth--;
    const tableNode = $first.node(tableDepth);
    const map = TableMap.get(tableNode);
    const tableStart = $first.start(tableDepth);
    const target = kind === "column" ? map.map[map.width - 1]! : map.map[map.map.length - map.width]!;
    run(() => {
      editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(editor.state.doc, tableStart + target)));
      if (kind === "column") editor.commands.addColumnAfter(); else editor.commands.addRowAfter();
    });
  }
  columnGrip.addEventListener("click", () => openMenu("column", columnGrip));
  rowGrip.addEventListener("click", () => openMenu("row", rowGrip));
  addColumn.addEventListener("click", () => { if (active) addAtEnd("column", active); });
  addRow.addEventListener("click", () => { if (active) addAtEnd("row", active); });

  function place(node: HTMLElement, left: number, top: number, width: number, height: number) {
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
    node.style.width = `${width}px`;
    node.style.height = `${height}px`;
  }
  function update() {
    frame = 0;
    if (hovered && !hovered.isConnected) hovered = null;
    const cell = menuKind && active?.isConnected ? active : hovered ?? selectionCell();
    const table = cell && editor.isEditable && !pressing ? tableOf(cell) : null;
    if (!cell || !table) { active = null; layer.hidden = true; if (menuKind) closeMenu(); return; }
    active = cell;
    layer.hidden = false;
    const wrapper = (table.parentElement ?? table).getBoundingClientRect();
    const tableRect = table.getBoundingClientRect();
    const cellRect = cell.getBoundingClientRect();
    const left = Math.max(tableRect.left, wrapper.left), right = Math.min(tableRect.right, wrapper.right);
    const cellLeft = Math.max(cellRect.left, left), cellRight = Math.min(cellRect.right, right);
    const titlebar = 42;
    const gripLong = 28, gripShort = 16, gap = 4;
    const centered = (start: number, end: number) => (start + end) / 2 - gripLong / 2;
    columnGrip.hidden = cellRight <= cellLeft || tableRect.top - gap - gripShort < titlebar;
    if (!columnGrip.hidden) place(columnGrip, Math.max(left, Math.min(centered(cellLeft, cellRight), right - gripLong)), tableRect.top - gap - gripShort, gripLong, gripShort);
    const cellTop = Math.max(cellRect.top, titlebar), cellBottom = Math.min(cellRect.bottom, window.innerHeight);
    rowGrip.hidden = left - gap - gripShort < 0 || cellBottom <= cellTop;
    if (!rowGrip.hidden) place(rowGrip, left - gap - gripShort, Math.max(cellTop, Math.min(centered(cellTop, cellBottom), cellBottom - gripLong)), gripShort, gripLong);
    addColumn.hidden = right + 4 + 14 > window.innerWidth || tableRect.bottom < titlebar;
    if (!addColumn.hidden) place(addColumn, right + 4, Math.max(tableRect.top, titlebar), 14, tableRect.bottom - Math.max(tableRect.top, titlebar));
    addRow.hidden = tableRect.bottom + 3 + 14 > window.innerHeight;
    if (!addRow.hidden) place(addRow, left, tableRect.bottom + 3, right - left, 14);
    if (menuKind) placeMenu(menuKind === "column" ? columnGrip : rowGrip, menuKind);
  }

  const cellAt = (target: EventTarget | null) => {
    const found = target instanceof Element ? target.closest(CELLS) : null;
    return found && root.contains(found) ? found as HTMLTableCellElement : null;
  };
  const over = (event: MouseEvent) => {
    if (menuKind) return;
    window.clearTimeout(leaveTimer);
    const cell = cellAt(event.target);
    if (cell && cell !== hovered) { hovered = cell; schedule(); }
  };
  const leave = () => {
    if (menuKind) return;
    window.clearTimeout(leaveTimer);
    leaveTimer = window.setTimeout(() => { if (!menuKind) { hovered = null; schedule(); } }, 180);
  };
  const enterControls = () => window.clearTimeout(leaveTimer);
  const pointerdown = (event: PointerEvent) => {
    if (event.button === 0 && root.contains(event.target as Node)) { pressing = true; schedule(); }
    if (menuKind && !menu.contains(event.target as Node) && event.target !== columnGrip && event.target !== rowGrip) closeMenu();
  };
  const pointerup = () => { if (pressing) { pressing = false; schedule(); } };
  const keydown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && menuKind) { closeMenu(); editor.view.focus(); }
    else if (menuKind && (event.key === "ArrowDown" || event.key === "ArrowUp") && menu.contains(document.activeElement)) {
      event.preventDefault();
      const items = [...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      const next = items.indexOf(document.activeElement as HTMLButtonElement) + (event.key === "ArrowDown" ? 1 : -1);
      items[(next + items.length) % items.length]?.focus();
    }
  };
  const transaction = ({ transaction: tr }: { transaction: Transaction }) => {
    if (tr.docChanged || tr.selectionSet) schedule();
    if (menuKind && tr.docChanged && tr.getMeta("preventUpdate")) closeMenu();
  };

  root.addEventListener("mouseover", over);
  root.addEventListener("mouseleave", leave);
  layer.addEventListener("mouseenter", enterControls);
  layer.addEventListener("mouseleave", leave);
  document.addEventListener("pointerdown", pointerdown, true);
  document.addEventListener("pointerup", pointerup);
  document.addEventListener("keydown", keydown);
  window.addEventListener("scroll", schedule, true);
  window.addEventListener("resize", schedule);
  editor.on("transaction", transaction);
  editor.on("focus", schedule);
  schedule();

  return { destroy() {
    window.cancelAnimationFrame(frame);
    window.clearTimeout(leaveTimer);
    root.removeEventListener("mouseover", over);
    root.removeEventListener("mouseleave", leave);
    document.removeEventListener("pointerdown", pointerdown, true);
    document.removeEventListener("pointerup", pointerup);
    document.removeEventListener("keydown", keydown);
    window.removeEventListener("scroll", schedule, true);
    window.removeEventListener("resize", schedule);
    editor.off("transaction", transaction);
    editor.off("focus", schedule);
    layer.remove();
  } };
}
