export function downloadFile(
  content: string,
  filename: string,
  mimeType: string = "text/plain",
): void {
  downloadBlobPart(content, filename, mimeType);
}

export function downloadBlobPart(
  content: BlobPart,
  filename: string,
  mimeType: string = "application/octet-stream",
): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  URL.revokeObjectURL(url);
}
