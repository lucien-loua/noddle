import { useId } from "react";

export function NoddleMark({ className }: { className?: string }) {
  const maskId = useId();

  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      focusable="false"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <mask
        height="24"
        id={maskId}
        maskUnits="userSpaceOnUse"
        width="24"
        x="0"
        y="0"
      >
        <rect fill="white" height="24" rx="6.2" width="24" x="0" y="0" />
        <rect
          fill="black"
          height="4.2"
          rx="2.1"
          width="10.4"
          x="6.8"
          y="15.7"
        />
      </mask>
      <rect
        fill="currentColor"
        height="24"
        mask={`url(#${maskId})`}
        rx="6.2"
        width="24"
        x="0"
        y="0"
      />
    </svg>
  );
}
