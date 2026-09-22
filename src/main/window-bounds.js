const DEFAULT_MIN_VISIBLE_SIZE = 48;

function normalizeRect(rect) {
  const x = Number(rect?.x);
  const y = Number(rect?.y);
  const width = Number(rect?.width);
  const height = Number(rect?.height);

  if (
    !Number.isFinite(x)
    || !Number.isFinite(y)
    || !Number.isFinite(width)
    || !Number.isFinite(height)
    || width <= 0
    || height <= 0
  ) {
    return null;
  }

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height)
  };
}

function intersectionSize(first, second) {
  return {
    width: Math.max(0, Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x)),
    height: Math.max(0, Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y))
  };
}

function isWindowVisible(bounds, workAreas, minVisibleSize = DEFAULT_MIN_VISIBLE_SIZE) {
  const requiredWidth = Math.min(bounds.width, minVisibleSize);
  const requiredHeight = Math.min(bounds.height, minVisibleSize);

  return workAreas.some((workArea) => {
    const intersection = intersectionSize(bounds, workArea);
    return intersection.width >= requiredWidth && intersection.height >= requiredHeight;
  });
}

function distanceToRectSquared(point, rect) {
  const nearestX = Math.max(rect.x, Math.min(point.x, rect.x + rect.width));
  const nearestY = Math.max(rect.y, Math.min(point.y, rect.y + rect.height));
  const deltaX = point.x - nearestX;
  const deltaY = point.y - nearestY;
  return deltaX * deltaX + deltaY * deltaY;
}

function chooseTargetWorkArea(bounds, workAreas, sourceWorkArea, primaryWorkArea) {
  const reference = sourceWorkArea || bounds;
  const point = {
    x: reference.x + reference.width / 2,
    y: reference.y + reference.height / 2
  };

  return workAreas.reduce((best, candidate) => {
    const distance = distanceToRectSquared(point, candidate);
    if (!best || distance < best.distance) {
      return { workArea: candidate, distance };
    }
    return best;
  }, primaryWorkArea ? {
    workArea: primaryWorkArea,
    distance: distanceToRectSquared(point, primaryWorkArea)
  } : null)?.workArea || workAreas[0];
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function positiveModulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

function getRelativePosition(value, windowSize, sourceWorkArea, axis, sizeKey) {
  const sourceStart = sourceWorkArea?.[axis];
  const sourceSize = sourceWorkArea?.[sizeKey];
  const availableSourceSize = Number.isFinite(sourceSize) ? sourceSize - windowSize : 0;

  if (Number.isFinite(sourceStart) && availableSourceSize > 0) {
    return clamp((value - sourceStart) / availableSourceSize, 0, 1);
  }

  if (sourceSize > 0) {
    return clamp((value - sourceStart) / sourceSize, 0, 1);
  }

  return null;
}

function getLegacyRelativePosition(value, targetStart, targetSize) {
  if (targetSize <= 0) {
    return 0;
  }

  return positiveModulo(value - targetStart, targetSize) / targetSize;
}

function ensureVisibleBounds(rawBounds, rawWorkAreas, rawSourceWorkArea, rawPrimaryWorkArea) {
  const bounds = normalizeRect(rawBounds);
  const workAreas = (Array.isArray(rawWorkAreas) ? rawWorkAreas : []).map(normalizeRect).filter(Boolean);
  const sourceWorkArea = normalizeRect(rawSourceWorkArea);
  const primaryWorkArea = normalizeRect(rawPrimaryWorkArea);

  if (!bounds || !workAreas.length || isWindowVisible(bounds, workAreas)) {
    return bounds || rawBounds;
  }

  const target = chooseTargetWorkArea(bounds, workAreas, sourceWorkArea, primaryWorkArea);
  const availableTargetWidth = Math.max(0, target.width - bounds.width);
  const availableTargetHeight = Math.max(0, target.height - bounds.height);
  const relativeX = getRelativePosition(bounds.x, bounds.width, sourceWorkArea, 'x', 'width')
    ?? getLegacyRelativePosition(bounds.x, target.x, target.width);
  const relativeY = getRelativePosition(bounds.y, bounds.height, sourceWorkArea, 'y', 'height')
    ?? getLegacyRelativePosition(bounds.y, target.y, target.height);

  return {
    ...bounds,
    x: Math.round(target.x + relativeX * availableTargetWidth),
    y: Math.round(target.y + relativeY * availableTargetHeight)
  };
}

module.exports = {
  DEFAULT_MIN_VISIBLE_SIZE,
  ensureVisibleBounds,
  isWindowVisible,
  normalizeRect
};
