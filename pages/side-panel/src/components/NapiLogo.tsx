interface NapiLogoProps {
  className?: string;
}

// napi's in-app logo — a lightbulb-in-a-circle, since "guide/highlight/idea"
// is exactly what the product does. Inline SVG rather than a PNG: no image
// tools available in this environment to recolor the old icon files, and an
// inline SVG is trivial to theme and never blurs at any size. Note: this
// only changes the logo shown INSIDE the app (side panel header) — the
// actual Chrome toolbar/extensions-page icon is still the old PNG files
// (icon-128.png / icon-32.png) and needs real icon assets to change.
const NapiLogo = ({ className = 'size-6' }: NapiLogoProps) => (
  <svg viewBox="0 0 24 24" fill="none" className={className} aria-label="napi logo" role="img">
    <circle cx="12" cy="12" r="12" fill="#EAB308" />
    <path
      d="M12 5.5c-2.5 0-4.5 2-4.5 4.5 0 1.6.85 3 2.1 3.8.3.2.4.5.4.85V15c0 .28.22.5.5.5h3c.28 0 .5-.22.5-.5v-.35c0-.35.1-.65.4-.85 1.25-.8 2.1-2.2 2.1-3.8 0-2.5-2-4.5-4.5-4.5Z"
      fill="#1F2937"
    />
    <rect x="10" y="16.5" width="4" height="1.3" rx="0.65" fill="#1F2937" />
    <rect x="10.4" y="18.2" width="3.2" height="1.1" rx="0.55" fill="#1F2937" />
  </svg>
);

export default NapiLogo;
