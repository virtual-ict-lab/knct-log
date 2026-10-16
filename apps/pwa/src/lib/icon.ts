import { MAX_ICON_CHARS, isIcon } from "@knct-log/core";

/** 切り出す範囲。zoom >= 1 で拡大、x / y は -1..1（中央からのずらし。端まで動かすと端に接する） */
export interface Crop {
  zoom: number;
  x: number;
  y: number;
}

export async function loadImage(file: Blob): Promise<ImageBitmap> {
  return createImageBitmap(file, { imageOrientation: "from-image" });
}

/** 画像の正方形の切り出し範囲（元画像のピクセル） */
export function cropRect(w: number, h: number, c: Crop) {
  const base = Math.min(w, h);
  const side = base / Math.max(1, c.zoom);
  const sx = (w - side) / 2 + (Math.max(-1, Math.min(1, c.x)) * (w - side)) / 2;
  const sy = (h - side) / 2 + (Math.max(-1, Math.min(1, c.y)) * (h - side)) / 2;
  return { sx, sy, side };
}

/** 正方形に切り出して size px に縮小する */
export function drawCrop(img: ImageBitmap, c: Crop, size: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const { sx, sy, side } = cropRect(img.width, img.height, c);
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
  return canvas;
}

const toBlob = (canvas: HTMLCanvasElement, type: string, q: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, q));

function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/**
 * アイコン用の data URL を作る。レコードの上限（MAX_ICON_CHARS）に収まるまで
 * 画質・大きさを下げる。WebP を優先し、ブラウザが対応していなければ JPEG。
 */
export async function encodeIcon(img: ImageBitmap, crop: Crop): Promise<string> {
  for (const size of [128, 112, 96, 64]) {
    const canvas = drawCrop(img, crop, size);
    for (const q of [0.8, 0.65, 0.5, 0.35]) {
      for (const type of ["image/webp", "image/jpeg"]) {
        const blob = await toBlob(canvas, type, q);
        if (!blob || blob.type !== type) continue; // 非対応だと PNG が返る
        const url = await toDataUrl(blob);
        if (isIcon(url)) return url;
      }
    }
  }
  throw new Error(`アイコンを ${MAX_ICON_CHARS} 文字以内にできませんでした`);
}
