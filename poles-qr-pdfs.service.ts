/**
 * The code was originally for a nestjs service. i have modified it to be standalone.
 * original purpose: generate a PDF with QR codes and logos for a list of links, each link having a URL and an ID. the qrs were to be printed and used on pole tags.
 */

import * as path from "path";
import * as fs from "fs";
import * as QRCode from "qrcode";
import sharp = require("sharp");
import PDFDocument = require("pdfkit");
import pLimit = require("p-limit");
import { Writable } from "stream";

interface QrLink {
  url: string;
  id: string;
}

// @Injectable()
export class PoleQrPdfService {
  // private readonly logger = new Logger(PoleQrPdfService.name);
  private readonly logger = console; // using console for logging in standalone version
  private readonly pageWidth = 169.92;
  private readonly pageHeight = 283.68;
  private logoBufferCache: Buffer | null = null;

  private async getLogoBuffer(): Promise<Buffer> {
    if (!this.logoBufferCache) {
      this.logoBufferCache = await sharp(
        path.join(process.cwd(), "assets", "placeholder-icon.png"),
      )
        .resize({ width: 67 })
        .toBuffer();
    }
    return this.logoBufferCache;
  }

  private async buildQrWithLogo(
    url: string,
    logoBuffer: Buffer,
  ): Promise<string> {
    // Generate a larger QR code
    const qrCodeDataUrl = await QRCode.toDataURL(url, {
      width: 332,
      margin: 1,
      errorCorrectionLevel: "H",
    });

    // Load the QR code and logo images
    const qrCodeImageBuffer = Buffer.from(
      qrCodeDataUrl.split(",")[1],
      "base64",
    );

    // Get metadata of QR code image
    const qrCodeMetadata = await sharp(qrCodeImageBuffer).metadata();

    // Resize the logo to fit within the QR code
    // const logoSize = Math.min(qrCodeMetadata.width, qrCodeMetadata.height) / 4;
    const logoSize =
      Math.min(qrCodeMetadata.width ?? 332, qrCodeMetadata.height ?? 332) / 4;
    const resizedLogoBuffer = await sharp(logoBuffer)
      .resize(logoSize, logoSize, { fit: "inside", withoutEnlargement: true })
      .toBuffer();

    // Composite the logo onto the QR code
    const qrCodeWithLogoBuffer = await sharp(qrCodeImageBuffer)
      .composite([{ input: resizedLogoBuffer, gravity: "center" }])
      .png()
      .toBuffer();

    return `data:image/png;base64,${qrCodeWithLogoBuffer.toString("base64")}`;
  }

  private drawPage(
    doc: PDFKit.PDFDocument,
    id: string,
    qrCodeWithLogoDataUrl: string,
  ): void {
    const { pageWidth, pageHeight } = this;
    const borderRadius = 5;
    const borderWidth = 1.5;
    const borderInset = 0.5;

    doc.lineWidth(borderWidth);
    doc.strokeColor("black");

    // Draw the rounded border rectangle
    doc
      .roundedRect(
        borderInset,
        borderInset,
        pageWidth - 2 * borderInset,
        pageHeight - 2 * borderInset,
        borderRadius,
      )
      .stroke();

    // Add the text lines to the PDF
    const textLines = [
      "SAFARICOM",
      "8m",
      "+254 222 333 444",
      "WOOD",
      "Ø110-130mm",
      "Ø180-210mm",
    ];
    const textLineHeight = 10;
    const textLineXPosition = 5;
    const textLineYPosition = 5;
    const textLineSpacing = 10;

    doc.fontSize(16);
    doc.fillColor("black");
    for (let i = 0; i < textLines.length; i++) {
      doc.text(
        textLines[i],
        textLineXPosition,
        textLineYPosition + i * (textLineHeight + textLineSpacing),
        { align: "center" },
      );
    }

    // Add the QR code with logo to the PDF
    const qrCodeWidth = 127.44;
    const qrCodeHeight = 127.44;
    const xPosition = (pageWidth - qrCodeWidth) / 2;
    doc.image(qrCodeWithLogoDataUrl, xPosition, undefined, {
      fit: [qrCodeWidth, qrCodeHeight],
      align: "center",
    });

    // Add the ID text to bottom center of the page
    const textWidth = doc.widthOfString(id);
    const textHeight = doc.heightOfString(id);
    const textXPosition = (pageWidth - textWidth) / 2;
    const textYPosition = pageHeight - textHeight - 5;
    doc.text(id, textXPosition, textYPosition, { continued: false });
  }

  // stream pdf to given writable, to prevent buffering the entire PDF in memory
  async streamQrPdf(
    links: QrLink[],
    destination: Writable,
    concurrency = 10,
  ): Promise<void> {
    const doc = new PDFDocument({
      size: [this.pageWidth, this.pageHeight],
      margin: 0,
    });
    doc.pipe(destination);

    const logoBuffer = await this.getLogoBuffer();
    const limit = pLimit(concurrency);

    // // generate all QR and logo images
    const images = await Promise.all(
      links.map((link) =>
        limit(async () => {
          try {
            return await this.buildQrWithLogo(link.url, logoBuffer);
          } catch (error) {
            this.logger.error(`Failed to generate QR for ${link.id}`, error);
            throw error;
          }
        }),
      ),
    );

    // PDFKit does not support concurrent writes, pages drawn in order
    links.forEach((link, i) => {
      if (i > 0) doc.addPage();
      this.drawPage(doc, link.id, images[i]);
    });

    doc.end();

    return new Promise((resolve, reject) => {
      destination.on("finish", () => resolve());
      doc.on("error", (error) => {
        this.logger.error("Error generating PDF", error);
        reject(new Error("Failed to generate PDF"));
      });
    });
  }

  // wrapper for streaming to a buffer: for callers who still want a Buffer
  async generateQrPdf(links: QrLink[], concurrency = 10): Promise<Buffer> {
    const buffers: Buffer[] = [];
    const collector = new Writable({
      write(chunk, _enc, callback) {
        buffers.push(chunk);
        callback();
      },
    });

    await this.streamQrPdf(links, collector, concurrency);
    return Buffer.concat(buffers);
  }

  // for large batches, split into multiple PDFs, each with a maximum of 500 pages
  async *streamQrPdfChunks(
    links: QrLink[],
    chunkSize = 500,
    concurrency = 10,
  ): AsyncGenerator<{ buffer: Buffer; index: number }> {
    for (let i = 0; i < links.length; i += chunkSize) {
      const chunk = links.slice(i, i + chunkSize);
      const buffer = await this.generateQrPdf(chunk, concurrency);
      yield { buffer, index: i / chunkSize };
    }
  }
}
