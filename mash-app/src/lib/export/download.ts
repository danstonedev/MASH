export async function downloadFile(
  content: string,
  filename: string,
  mimeType: string = "text/plain",
): Promise<void> {
  await downloadBlobPart(content, filename, mimeType);
}

export async function downloadBlobPart(
  content: BlobPart,
  filename: string,
  mimeType: string = "application/octet-stream",
): Promise<void> {
  let blob = new Blob([content], { type: mimeType });
  let downloadName = filename;
  let downloadMimeType = mimeType;

  const shouldCompressJson =
    mimeType === "application/json" || filename.toLowerCase().endsWith(".json");

  if (shouldCompressJson && typeof CompressionStream !== "undefined") {
    try {
      const compressedStream = blob
        .stream()
        .pipeThrough(new CompressionStream("gzip"));
      blob = await new Response(compressedStream).blob();
      downloadName = downloadName.endsWith(".gz")
        ? downloadName
        : `${downloadName}.gz`;
      downloadMimeType = "application/gzip";
    } catch (error) {
      console.warn(
        "[download] JSON gzip compression failed, downloading plain JSON:",
        error,
      );
    }
  }

  if (downloadMimeType !== mimeType) {
    blob = new Blob([blob], { type: downloadMimeType });
  }

  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = downloadName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  URL.revokeObjectURL(url);
}
