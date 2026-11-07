import { viewIcons } from "../navigation";

// Same accessible navigation icons on desktop and iPhone. Semantic colours come from the
// design-system tokens in app/lumi-navigation.css; SVGs inherit currentColor.
// The approved Lumi v1 project shape is an unfilled circle. Here it is
// decorative navigation identity, never a completion toggle. Real project
// completion controls live in project rows and remain separate.
export function ProjectIcon({ previewCircle = false }: { previewCircle?: boolean } = {}) {
  return (
    <svg className="projectGlyph" data-project-shape={previewCircle ? "circle" : "archive"}
      viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor"
      strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {previewCircle ? (
        <circle cx="8" cy="8" r="5.6" />
      ) : (
        <>
          <rect x="1.75" y="2.5" width="12.5" height="3.5" rx="0.9" />
          <path d="M2.75 6v6.1c0 .77.63 1.4 1.4 1.4h7.7c.77 0 1.4-.63 1.4-1.4V6" />
          <path d="M6.25 8.9h3.5" />
        </>
      )}
    </svg>
  );
}

const outline = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
export function ViewIcon({ name }: { name: string }) {
  switch (name) {
    case "Home": return <svg viewBox="0 0 16 16" width="1em" height="1em" {...outline} aria-hidden="true"><path d="M2 7.2 8 2.2l6 5"/><path d="M3.6 6v7.75h8.8V6"/><path d="M6.6 13.75V9.9h2.8v3.85"/></svg>;
    case "MyPlanPreview": return <svg viewBox="0 0 16 16" width="1em" height="1em" aria-hidden="true"><path fill="currentColor" d="m8 1.4 1.96 4.06 4.44.6-3.24 3.1.8 4.42L8 11.46l-3.96 2.12.8-4.42L1.6 6.06l4.44-.6z"/></svg>;
    // Keep the existing legacy Today icon unchanged; in design v1 use
    // a distinct day icon so the star is reserved for My Plan.
    case "TodayV1": return <svg viewBox="0 0 16 16" width="1em" height="1em" {...outline} aria-hidden="true"><rect x="2.5" y="3.5" width="11" height="10.5" rx="2"/><path d="M2.5 6.5h11M5 1.8v3M11 1.8v3M5.75 9.5h4.5"/></svg>;
    case "Today": return <svg viewBox="0 0 16 16" width="1em" height="1em" aria-hidden="true"><path fill="currentColor" d="m8 1.4 1.96 4.06 4.44.6-3.24 3.1.8 4.42L8 11.46l-3.96 2.12.8-4.42L1.6 6.06l4.44-.6z"/></svg>;
    case "Projects": return <ProjectIcon />;
    case "ProjectsV1": return <ProjectIcon previewCircle />;
    case "Notes": return <svg viewBox="0 0 16 16" width="1em" height="1em" {...outline} aria-hidden="true"><path d="M3.5 1.75h6l3 3v9.5h-9z"/><path d="M9.5 1.75v3h3"/><path d="M5.75 8.25h4.5M5.75 10.75h3"/></svg>;
    case "Calendar": return <svg viewBox="0 0 16 16" width="1em" height="1em" {...outline} aria-hidden="true"><rect x="2" y="3" width="12" height="11" rx="2"/><path d="M2 6.5h12M5.25 1.5v3M10.75 1.5v3"/><path d="M5 9.25h.01M8 9.25h.01M11 9.25h.01M5 11.75h.01M8 11.75h.01" strokeWidth="2"/></svg>;
    case "Search": return <svg viewBox="0 0 16 16" width="1em" height="1em" {...outline} strokeWidth="1.8" aria-hidden="true"><circle cx="7" cy="7" r="4.75"/><path d="m10.5 10.5 3.75 3.75"/></svg>;
    default: return <>{viewIcons[name]}</>;
  }
}
