import { TableView } from "@tiptap/extension-table";
import type { Node } from "@tiptap/pm/model";

// TableView only sets min-width on a column whose width was cleared, so the
// old pixel width would stay after "Reset column widths" or an undo.
export class ColumnWidthTableView extends TableView {
  update(node: Node) {
    const updated = super.update(node);
    if (!updated) return false;
    let column = this.colgroup.firstElementChild as HTMLElement | null;
    for (const cell of node.firstChild?.children ?? []) {
      for (let span = 0; span < cell.attrs.colspan; span++, column = column?.nextElementSibling as HTMLElement | null) {
        if (!cell.attrs.colwidth?.[span]) column?.style.removeProperty("width");
      }
    }
    return true;
  }
}
