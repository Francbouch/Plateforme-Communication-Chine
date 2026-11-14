import { PDFDocument, StandardFonts, degrees, rgb } from "@cantoo/pdf-lib";
/** Synthetic SolidWorks-like sheet; no industrial data or remote services. */
export async function technicalPdf(revision = "A") {
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([600, 400]);
  page.drawRectangle({
    x: 20,
    y: 30,
    width: 560,
    height: 340,
    borderWidth: 1,
    borderColor: rgb(0, 0, 0),
  });
  page.drawLine({
    start: { x: 20, y: 260 },
    end: { x: 580, y: 260 },
    thickness: 1,
  });
  page.drawText("REMOVE SHARP EDGES", { x: 40, y: 320, size: 12, font });
  page.drawText('±0.010 Ø0.530 M8 × 1.25 1/4-20 UNC 9/16"', {
    x: 40,
    y: 290,
    size: 10,
    font,
  });
  page.drawText("MATERIAL AISI 304", { x: 40, y: 240, size: 12, font });
  page.drawText("SURFACE FINISH 3 mm", {
    x: 530,
    y: 60,
    size: 10,
    font,
    rotate: degrees(90),
  });
  page.drawText("GENERAL NOTES", {
    x: 240,
    y: 140,
    size: 10,
    font,
    rotate: degrees(45),
  });
  page.drawText(`LC-120-003 Rev. ${revision}`, {
    x: 320,
    y: 45,
    size: 10,
    font,
  });
  const second = doc.addPage([600, 400]);
  second.drawText("Enlever les arêtes", { x: 40, y: 320, size: 12, font });
  second.drawText("GENERAL NOTES", {
    x: 100,
    y: 80,
    size: 10,
    font,
    rotate: degrees(-90),
  });
  doc
    .addPage([600, 400])
    .drawRectangle({ x: 50, y: 50, width: 150, height: 150, borderWidth: 2 });
  const rotated = doc.addPage([600, 400]);
  rotated.setRotation(degrees(90));
  rotated.drawText("REMOVE SHARP EDGES", { x: 40, y: 320, size: 12, font });
  return Buffer.from(await doc.save());
}
