import React from 'react'

interface IconProps {
  size?: number
  className?: string
}

function Svg({ size = 16, className, children }: IconProps & { children: React.ReactNode }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {children}
    </svg>
  )
}

export const PlusIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
)

export const RenameIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="m4 20 4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20Z" />
    <path d="m13.5 8 3 3" />
  </Svg>
)

/** Five-pointed star; CSS fills it when a thread is pinned. */
export const StarIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="m12 3 2.7 5.6 6.1.8-4.5 4.2 1.1 6-5.4-2.9-5.4 2.9 1.1-6L3.2 9.4l6.1-.8L12 3Z" />
  </Svg>
)

export const FolderIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
  </Svg>
)

export const ChatIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M21 12a8 8 0 0 1-8 8H4l2-3a8 8 0 1 1 15-5Z" />
  </Svg>
)

export const SearchIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-4-4" />
  </Svg>
)

/** Two commits on a line, one branching away: the usual git branch glyph. */
export const BranchIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <circle cx="6" cy="6" r="2.4" />
    <circle cx="6" cy="18" r="2.4" />
    <circle cx="17" cy="8" r="2.4" />
    <path d="M6 8.4v7.2M17 10.4v1.1a4 4 0 0 1-4 4H6" />
  </Svg>
)

/** One line splitting into two: a thread taken from another thread. */
export const ForkIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <circle cx="12" cy="19" r="2.4" />
    <circle cx="7" cy="5" r="2.4" />
    <circle cx="17" cy="5" r="2.4" />
    <path d="M7 7.4v2.1a3 3 0 0 0 3 3h4a3 3 0 0 0 3-3V7.4M12 12.5v4.1" />
  </Svg>
)

export const ReviewIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M5 19 3 17l6-6 4 4 6-8 2 2-8 10-4-4-2 2Z" />
  </Svg>
)

export const FilesIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
    <path d="M14 3v5h5" />
  </Svg>
)

export const GlobeIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" />
  </Svg>
)

export const SendIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="m22 2-7 20-4-9-9-4 20-7Z" />
  </Svg>
)

export const StopIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <rect x="6" y="6" width="12" height="12" rx="1.5" />
  </Svg>
)

export const BackIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M15 18l-6-6 6-6" />
  </Svg>
)

export const ForwardIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M9 6l6 6-6 6" />
  </Svg>
)

export const ReloadIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M21 12a9 9 0 1 1-2.6-6.4" />
    <path d="M21 3v6h-6" />
  </Svg>
)

export const ChevronIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M9 6l6 6-6 6" />
  </Svg>
)

export const FileIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
    <path d="M14 3v5h5" />
  </Svg>
)

export const TerminalIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="m7 9 3 3-3 3M13 15h4" />
  </Svg>
)

export const PanelIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M15 4v16" />
  </Svg>
)

export const AttachmentIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M21.4 11.05 12.25 20.2a4.5 4.5 0 0 1-6.36-6.36l9.19-9.19a2.75 2.75 0 0 1 3.89 3.89l-9.2 9.19a1 1 0 0 1-1.41-1.41l8.28-8.28" />
  </Svg>
)

export const ExternalIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <path d="M15 3h6v6" />
    <path d="M10 14 21 3" />
  </Svg>
)

export const CopyIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </Svg>
)

export const CodeIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="m8 6-6 6 6 6M16 6l6 6-6 6" />
  </Svg>
)

export const GearIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
  </Svg>
)

export const PaletteIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <circle cx="13.5" cy="6.5" r="0.5" fill="currentColor" />
    <circle cx="17.5" cy="10.5" r="0.5" fill="currentColor" />
    <circle cx="8.5" cy="7.5" r="0.5" fill="currentColor" />
    <circle cx="6.5" cy="12.5" r="0.5" fill="currentColor" />
    <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2Z" />
  </Svg>
)

export const MicIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </Svg>
)

export const MicOffIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3M3 3l18 18" />
  </Svg>
)

export const VolumeIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M11 5 6 9H2v6h4l5 4V5Z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7M18 6a8 8 0 0 1 0 12" />
  </Svg>
)

export const TrashIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14M10 11v6M14 11v6" />
  </Svg>
)

export const UploadIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M12 15V3M7 8l5-5 5 5M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" />
  </Svg>
)

/** Backend marks.
 *
 *  The real brand paths, not drawings of them: an approximation at this size
 *  reads as a smudge, and the point of the mark is that it is recognised
 *  rather than learned. Sources are noted per mark.
 *
 *  Filled, not stroked, so they skip the Svg helper above — a 1.8px stroke
 *  closes the counters at tab size and every mark turns into a blob. They take
 *  their colour from the backend rather than from currentColor, which is what
 *  separates four Claude tabs from four Codex ones. */
function Mark({ size = 16, className, children }: IconProps & { children: React.ReactNode }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" className={className}>
      {children}
    </svg>
  )
}

/** Anthropic's burst, from simple-icons. The full Claude sunburst has far more
 *  detail than 16px can hold, so this is the mark Anthropic itself uses when
 *  the space is small. */
export const ClaudeMark = (p: IconProps): React.JSX.Element => (
  <Mark {...p}>
    <path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z" />
  </Mark>
)

/** OpenAI's knot, from lobe-icons. */
export const CodexMark = (p: IconProps): React.JSX.Element => (
  <Mark {...p}>
    <path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z" />
  </Mark>
)

/** OpenCode's mark, from lobe-icons: a square inside a square. */
export const OpenCodeMark = (p: IconProps): React.JSX.Element => (
  <Mark {...p}>
    <path d="M16 6H8v12h8V6zm4 16H4V2h16v20z" />
  </Mark>
)

/** The greek letter, drawn rather than set as text: a glyph would take the
 *  app's font and land at a different weight and baseline than its siblings. */
export const PiMark = (p: IconProps): React.JSX.Element => (
  <Mark {...p}>
    <path d="M4.2 6.6h15.4v2.5h-2.9v6.1c0 .75.28 1.1.92 1.1.38 0 .74-.1 1.08-.3l.5 2.3c-.66.34-1.4.5-2.2.5-2.06 0-3.2-1.06-3.2-3.2V9.1h-3.1v3.05c0 2.6-.66 4.6-2.1 6.1l-2.2-1.5c1.06-1.15 1.55-2.6 1.55-4.55V9.1H4.2V6.6Z" />
  </Mark>
)

/** Lab has no brand to borrow, so like the pi glyph this is drawn: a flask,
 *  which keeps a recognisable silhouette at tab size where a letter L would
 *  read as a stray mark. */
export const LabMark = (p: IconProps): React.JSX.Element => (
  <Mark {...p}>
    <path d="M9.6 3.5h4.8v2h-1.1v4.02c0 .42.11.83.32 1.19l4.53 7.79c.62 1.06-.15 2.4-1.38 2.4H7.23c-1.23 0-2-1.34-1.38-2.4l4.53-7.79c.21-.36.32-.77.32-1.19V5.5H9.6v-2Zm3.2 2H11.2v4.02c0 .77-.2 1.53-.59 2.2L9.4 14.1h5.2l-1.21-2.38a4.4 4.4 0 0 1-.59-2.2V5.5Z" />
  </Mark>
)

export const BACKEND_MARKS: Record<string, (p: IconProps) => React.JSX.Element> = {
  claude: ClaudeMark,
  codex: CodexMark,
  opencode: OpenCodeMark,
  pi: PiMark,
  lab: LabMark
}
