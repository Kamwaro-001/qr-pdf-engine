import * as fs from "fs";
import { PoleQrPdfService } from "./poles-qr-pdfs.service";

async function main() {
  const service = new PoleQrPdfService();

  const links = [
    { url: "https://example.com/pole/1", id: "POLE-001" },
    { url: "https://example.com/pole/2", id: "POLE-002" },
    { url: "https://example.com/pole/3", id: "POLE-003" },
  ];

  const buffer = await service.generateQrPdf(links);
  fs.writeFileSync("output.pdf", buffer);
  console.log("Done — check output.pdf");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
