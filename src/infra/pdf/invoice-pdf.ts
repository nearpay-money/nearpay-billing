/**
 * Invoice PDF renderer (lld/billing.md §11 d11): a dependency-free PDF 1.4 writer using the standard
 * Helvetica fonts (WinAnsi, no embedding), laid out from `templates/invoice-pdf/layout.json`. Output is a
 * pure function of the document (no clock, no randomness), so re-rendering yields the same bytes.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { formatUnits, minorUnits } from "@nearpay-internal/money";
import type { InvoiceDocument, PdfRenderer } from "../../app/pdf.js";

export interface Layout {
  page: { width: number; height: number; margin: number };
  fonts: { regular: string; bold: string };
  sizes: { title: number; heading: number; body: number; small: number; stamp: number };
  lineHeight: number;
  linesPerPage: number;
  columns: { description: number; quantity: number; unit: number; amount: number };
  labels: Record<string, string>;
  stampColor: [number, number, number];
}

export const LAYOUT_FILE = fileURLToPath(new URL("../../../templates/invoice-pdf/layout.json", import.meta.url));

export const loadLayout = (file = LAYOUT_FILE): Layout => JSON.parse(readFileSync(file, "utf8")) as Layout;

// Standard 14 font metrics (Adobe AFM), widths per 1000 em for ASCII 32–126.
// biome-ignore format: metric table
const HELVETICA = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
// biome-ignore format: metric table
const HELVETICA_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

type Font = "F1" | "F2";

/** Text in WinAnsi (Latin-1 subset); anything else becomes `?`. */
export function winAnsi(s: string): string {
  return [...s.normalize("NFC")].map((ch) => (ch.charCodeAt(0) <= 0xff && ch.length === 1 ? ch : "?")).join("");
}

export function textWidth(s: string, font: Font, size: number): number {
  const table = font === "F2" ? HELVETICA_BOLD : HELVETICA;
  let w = 0;
  for (const ch of winAnsi(s)) {
    const c = ch.charCodeAt(0);
    w += c >= 32 && c <= 126 ? (table[c - 32] as number) : 556;
  }
  return (w * size) / 1000;
}

const pdfEscape = (s: string) =>
  winAnsi(s)
    .replace(/[\\()]/g, (m) => `\\${m}`)
    .replace(/[\r\n\t]/g, " ");

/** Cuts `s` to fit `max` points (adds `...`). */
export function fitText(s: string, font: Font, size: number, max: number): string {
  if (textWidth(s, font, size) <= max) return s;
  let out = s;
  while (out.length > 0 && textWidth(`${out}...`, font, size) > max) out = out.slice(0, -1);
  return `${out}...`;
}

const n2 = (x: number) => (Math.round(x * 100) / 100).toString();

class Page {
  readonly ops: string[] = [];
  text(x: number, y: number, s: string, font: Font, size: number): void {
    this.ops.push(`BT /${font} ${n2(size)} Tf ${n2(x)} ${n2(y)} Td (${pdfEscape(s)}) Tj ET`);
  }
  right(xRight: number, y: number, s: string, font: Font, size: number): void {
    this.text(xRight - textWidth(s, font, size), y, s, font, size);
  }
  line(x1: number, y1: number, x2: number, y2: number, width = 0.5): void {
    this.ops.push(`${n2(width)} w ${n2(x1)} ${n2(y1)} m ${n2(x2)} ${n2(y2)} l S`);
  }
  stamp(x: number, y: number, s: string, size: number, rgb: readonly number[]): void {
    const [r, g, b] = rgb.map(n2);
    this.ops.push(`q ${r} ${g} ${b} rg ${r} ${g} ${b} RG 0.966 0.259 -0.259 0.966 ${n2(x)} ${n2(y)} cm`);
    this.ops.push(`BT /F2 ${n2(size)} Tf 0 0 Td (${pdfEscape(s)}) Tj ET Q`);
  }
}

/** Serialises pages into a PDF file (objects, xref, trailer) with exact byte offsets. */
export function writePdf(pages: readonly Page[], fonts: { regular: string; bold: string }, title: string): Uint8Array {
  const objs: string[] = [];
  const pageIds = pages.map((_, i) => 5 + i * 2);
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objs[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /${fonts.regular} /Encoding /WinAnsiEncoding >>`;
  objs[4] = `<< /Type /Font /Subtype /Type1 /BaseFont /${fonts.bold} /Encoding /WinAnsiEncoding >>`;
  pages.forEach((p, i) => {
    const content = p.ops.join("\n");
    const id = pageIds[i] as number;
    objs[id] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${id + 1} 0 R >>`;
    objs[id + 1] = `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`;
  });
  const infoId = objs.length;
  objs[infoId] = `<< /Title (${pdfEscape(title)}) /Producer (NearPay billing) >>`;
  let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offsets: number[] = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = Buffer.byteLength(out, "latin1");
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}

const day = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);

/** `1234` usd → `USD 12.34`; asset base units with the asset's decimals and symbol. */
export function money(amount: bigint, doc: InvoiceDocument): string {
  const inv = doc.invoice;
  if (inv.currency === "asset") {
    const a = doc.pricingAsset;
    return a ? `${formatUnits(amount, a.decimals, Math.min(2, a.decimals))} ${a.symbol}` : `${amount} (${inv.assetId})`;
  }
  const d = minorUnits(inv.currency);
  return `${inv.currency.toUpperCase()} ${formatUnits(amount, d, d)}`;
}

export function invoicePdfRenderer(layout: Layout = loadLayout()): PdfRenderer {
  const L = layout.labels;
  const { width, height, margin } = layout.page;
  const right = width - margin;
  const col = (x: number) => margin + x;
  return {
    render(doc) {
      const inv = doc.invoice;
      const pages: Page[] = [];
      const lh = layout.lineHeight;
      const S = layout.sizes;
      const chunks: (typeof inv.lines)[] = [];
      for (let i = 0; i < Math.max(1, inv.lines.length); i += layout.linesPerPage)
        chunks.push(inv.lines.slice(i, i + layout.linesPerPage));

      chunks.forEach((lines, pi) => {
        const p = new Page();
        pages.push(p);
        let y = height - margin - S.title;
        p.text(margin, y, L.title ?? "Invoice", "F2", S.title);
        p.right(right, y, fitText(doc.merchantName, "F2", S.heading, 250), "F2", S.heading);
        if (!inv.livemode) p.right(right, y - lh, L.testMode ?? "TEST MODE", "F1", S.small);
        y -= 2 * lh + 6;
        if (pi === 0) {
          const meta: [string, string][] = [
            [L.number ?? "Invoice number", inv.number ?? ""],
            [L.issued ?? "Date of issue", inv.finalizedAt === null ? "" : day(inv.finalizedAt)],
            [L.due ?? "Date due", inv.dueDate === null ? "" : day(inv.dueDate)],
          ];
          if (inv.period)
            meta.push([L.period ?? "Service period", `${day(inv.period.start)} - ${day(inv.period.end)}`]);
          for (const [k, v] of meta) {
            p.text(margin, y, k, "F2", S.body);
            p.text(margin + 110, y, v, "F1", S.body);
            y -= lh;
          }
          y -= 6;
          p.text(margin, y, L.billTo ?? "Bill to", "F2", S.body);
          p.text(width / 2, y, L.from ?? "From", "F2", S.body);
          y -= lh;
          p.text(margin, y, fitText(doc.billTo.name ?? "", "F1", S.body, width / 2 - margin - 10), "F1", S.body);
          p.text(width / 2, y, fitText(doc.merchantName, "F1", S.body, width / 2 - margin), "F1", S.body);
          y -= lh;
          if (doc.billTo.email)
            p.text(margin, y, fitText(doc.billTo.email, "F1", S.body, width / 2 - margin - 10), "F1", S.body);
          y -= lh;
          if (inv.description) {
            y -= 4;
            p.text(margin, y, fitText(inv.description, "F1", S.body, right - margin), "F1", S.body);
            y -= lh;
          }
          y -= 8;
        } else {
          p.text(margin, y, `${inv.number ?? ""} (${L.continued ?? "continued"})`, "F1", S.body);
          y -= 2 * lh;
        }
        // table header
        p.text(col(layout.columns.description), y, L.description ?? "Description", "F2", S.body);
        p.right(col(layout.columns.quantity) + 30, y, L.quantity ?? "Qty", "F2", S.body);
        p.right(col(layout.columns.unit) + 50, y, L.unit ?? "Unit price", "F2", S.body);
        p.right(right, y, L.amount ?? "Amount", "F2", S.body);
        y -= 5;
        p.line(margin, y, right, y);
        y -= lh;
        for (const l of lines) {
          p.text(
            col(layout.columns.description),
            y,
            fitText(l.description, "F1", S.body, layout.columns.quantity - 50),
            "F1",
            S.body,
          );
          p.right(col(layout.columns.quantity) + 30, y, String(l.quantity), "F1", S.body);
          p.right(col(layout.columns.unit) + 50, y, money(l.unitAmount, doc), "F1", S.body);
          p.right(right, y, money(l.amount, doc), "F1", S.body);
          if (l.period) {
            y -= lh - 3;
            p.text(
              col(layout.columns.description) + 8,
              y,
              `${day(l.period.start)} - ${day(l.period.end)}`,
              "F1",
              S.small,
            );
          }
          y -= lh;
        }
        if (pi === chunks.length - 1) {
          p.line(width / 2, y + lh - 5, right, y + lh - 5);
          y -= 4;
          const rows: [string, string, Font][] = [[L.subtotal ?? "Subtotal", money(inv.subtotal, doc), "F1"]];
          for (const t of inv.totalTaxAmounts) {
            const name = `${t.displayName}${t.jurisdiction ? ` (${t.jurisdiction})` : ""} ${t.percentage}%${t.inclusive ? ` ${L.inclusive ?? "incl."}` : ""}`;
            rows.push([name, money(t.amount, doc), "F1"]);
          }
          if (inv.tax > 0n)
            rows.push([L.totalExcludingTax ?? "Total excluding tax", money(inv.totalExcludingTax, doc), "F1"]);
          rows.push([L.total ?? "Total", money(inv.total, doc), "F2"]);
          rows.push([L.paid ?? "Amount paid", money(inv.amountPaid, doc), "F1"]);
          rows.push([L.due_amount ?? "Amount due", money(inv.total - inv.amountPaid, doc), "F2"]);
          for (const [k, v, f] of rows) {
            p.text(width / 2, y, fitText(k, f, S.body, right - width / 2 - 110), f, S.body);
            p.right(right, y, v, f, S.body);
            y -= lh;
          }
          if (inv.footer)
            p.text(margin, margin + lh, fitText(inv.footer, "F1", S.small, right - margin), "F1", S.small);
        }
        p.right(right, margin, `${L.page ?? "Page"} ${pi + 1}/${chunks.length}`, "F1", S.small);
        if (doc.stamp) p.stamp(margin + 40, height * 0.25, doc.stamp, S.stamp, layout.stampColor);
      });
      return writePdf(pages, layout.fonts, `${L.title ?? "Invoice"} ${inv.number ?? ""}`);
    },
  };
}
