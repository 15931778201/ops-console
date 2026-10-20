export default function Wave() {
  return (
    <svg
      className="bg-login-waves"
      xmlns="http://www.w3.org/2000/svg"
      xmlnsXlink="http://www.w3.org/1999/xlink"
      viewBox="0 24 150 28"
      preserveAspectRatio="none"
      shapeRendering="auto"
    >
      <defs>
        <path
          id="gentle-wave"
          d="M-160 44c30 0 58-18 88-18s 58 18 88 18 58-18 88-18 58 18 88 18 v44h-352z"
        />
      </defs>
      <g>
        <use className="bg-login-wave-1 fill-white/70 dark:fill-black/70" href="#gentle-wave" x="48" y="0" />
        <use className="bg-login-wave-2 fill-white/50 dark:fill-black/50" href="#gentle-wave" x="48" y="3" />
        <use className="bg-login-wave-3 fill-white/30 dark:fill-black/30" href="#gentle-wave" x="48" y="5" />
        <use className="bg-login-wave-4 fill-white dark:fill-black" href="#gentle-wave" x="48" y="7" />
      </g>
    </svg>
  )
}
