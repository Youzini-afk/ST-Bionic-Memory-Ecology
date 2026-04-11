function clampUnit(value) {
  if (!Number.isFinite(Number(value))) return 0;
  return Math.min(1, Math.max(0, Number(value)));
}

export function isUsableGraphCanvasSize(width = 0, height = 0, minDimension = 48) {
  const normalizedWidth = Number(width);
  const normalizedHeight = Number(height);
  const threshold = Number.isFinite(Number(minDimension))
    ? Math.max(1, Number(minDimension))
    : 48;
  return (
    Number.isFinite(normalizedWidth) &&
    Number.isFinite(normalizedHeight) &&
    normalizedWidth >= threshold &&
    normalizedHeight >= threshold
  );
}

export function remapPositionBetweenRects(x = 0, y = 0, prevRect = null, nextRect = null) {
  const pointX = Number.isFinite(Number(x)) ? Number(x) : 0;
  const pointY = Number.isFinite(Number(y)) ? Number(y) : 0;
  if (!prevRect || !nextRect) {
    return {
      x: pointX,
      y: pointY,
    };
  }

  const prevX = Number.isFinite(Number(prevRect.x)) ? Number(prevRect.x) : 0;
  const prevY = Number.isFinite(Number(prevRect.y)) ? Number(prevRect.y) : 0;
  const prevW = Math.max(1, Number.isFinite(Number(prevRect.w)) ? Number(prevRect.w) : 0);
  const prevH = Math.max(1, Number.isFinite(Number(prevRect.h)) ? Number(prevRect.h) : 0);
  const nextX = Number.isFinite(Number(nextRect.x)) ? Number(nextRect.x) : 0;
  const nextY = Number.isFinite(Number(nextRect.y)) ? Number(nextRect.y) : 0;
  const nextW = Math.max(1, Number.isFinite(Number(nextRect.w)) ? Number(nextRect.w) : 0);
  const nextH = Math.max(1, Number.isFinite(Number(nextRect.h)) ? Number(nextRect.h) : 0);

  const relX = clampUnit((pointX - prevX) / prevW);
  const relY = clampUnit((pointY - prevY) / prevH);

  return {
    x: nextX + relX * nextW,
    y: nextY + relY * nextH,
  };
}
