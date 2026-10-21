import logo from '../assets/logo-white.webp';

/**
 * The He Is Real logo in the theme's logo colour: the white logo file used as a mask, filled
 * with `--logo` (white on dark, brand teal #4e9ba0 on light). The colour PNG sits on a black
 * square, so it can't go on white; this is the same logo without the square.
 */
export function Logo({
  size,
  className = '',
}: {
  size: number;
  className?: string;
}) {
  return (
    <span
      role="img"
      aria-label="He Is Real: Encounters with God"
      className={`inline-block shrink-0 bg-logo ${className}`}
      style={{
        width: size,
        height: size,
        maskImage: `url(${logo.src})`,
        WebkitMaskImage: `url(${logo.src})`,
        maskSize: 'contain',
        WebkitMaskSize: 'contain',
        maskRepeat: 'no-repeat',
        WebkitMaskRepeat: 'no-repeat',
      }}
    />
  );
}
