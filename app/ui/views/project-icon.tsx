import { viewIcons } from "../navigation";

// Projects are shown as an archive box. The other views keep their text glyphs.
export function ProjectIcon() {
  return (
    <svg className="projectGlyph" viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <rect x="1.75" y="2.5" width="12.5" height="3.5" rx="0.9" />
      <path d="M2.75 6v6.1c0 .77.63 1.4 1.4 1.4h7.7c.77 0 1.4-.63 1.4-1.4V6" />
      <path d="M6.25 8.9h3.5" />
    </svg>
  );
}

export function ViewIcon({ name }: { name: string }) {
  return name === "Projects" ? <ProjectIcon /> : <>{viewIcons[name]}</>;
}
