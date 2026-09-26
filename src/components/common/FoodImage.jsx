import React from 'react';

// Determines whether a stored path is an absolute OS filesystem path
// (selected via the native "Choose Image" file dialog) as opposed to a
// relative bundled asset path (e.g. seeded sample images under /food-images).
function resolveImageSrc(src) {
  if (/^https?:\/\//i.test(src) || src.startsWith('file:')) return src;
  const isAbsoluteOsPath = /^[a-zA-Z]:[\\/]/.test(src) || src.startsWith('/') || src.startsWith('\\\\');
  return isAbsoluteOsPath ? `file://${src}` : src;
}

// Shows the food image if available, otherwise a placeholder emoji tile.
export default function FoodImage({ src, alt, size = 72 }) {
  const [error, setError] = React.useState(false);
  const style = { width: size, height: size };

  if (!src || error) {
    return (
      <div className="food-image placeholder" style={style} aria-label={alt}>
        🍽️
      </div>
    );
  }

  return (
    <img
      className="food-image"
      style={style}
      src={resolveImageSrc(src)}
      alt={alt}
      onError={() => setError(true)}
    />
  );
}
