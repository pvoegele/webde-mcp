import { extractText, getDocumentProxy } from "unpdf";

/** Plain text of an attachment so Claude can classify it (invoice? business or private?). */
export async function attachmentText(contentType: string, filename: string, data: Buffer, maxChars: number) {
  const name = filename.toLowerCase();
  let text: string;
  if (contentType === "application/pdf" || name.endsWith(".pdf")) {
    const pdf = await getDocumentProxy(new Uint8Array(data));
    const r = await extractText(pdf, { mergePages: true });
    text = String(r.text ?? "");
    if (!text.trim()) text = "[PDF ohne Textebene – vermutlich gescannt. Nach Dateiname/Absender/Betreff einordnen.]";
  } else if (contentType.startsWith("text/") || /\.(txt|csv|xml|json|html?)$/.test(name)) {
    text = data.toString("utf8");
  } else {
    text = `[Kein Text extrahierbar für ${contentType}. Nach Dateiname/Absender/Betreff einordnen.]`;
  }
  text = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return text.length > maxChars ? text.slice(0, maxChars) + "\n…[gekürzt]" : text;
}
