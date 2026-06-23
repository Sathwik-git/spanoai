import { ImageResponse } from "next/og";

// Social link preview (1200×630) for every docs/landing route, using the
// SpanoAI mesh mark. Next auto-wires this as og:image (and twitter:image).
export const alt =
  "SpanoAI — shared context store, message bus, and audit log for multi-agent systems";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#09090b",
          color: "#fafafa",
          padding: "80px",
        }}
      >
        {/* brand lockup */}
        <div style={{ display: "flex", alignItems: "center", gap: "22px" }}>
          <svg width="92" height="92" viewBox="0 0 24 24" fill="none">
            <path d="M12 5 5 18.5 19 18.5Z" stroke="#fff" strokeWidth="1.6" strokeLinejoin="round" opacity="0.4" />
            <path d="M12 12.5V5" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" opacity="0.85" />
            <path d="M12 12.5 5 18.5" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" opacity="0.85" />
            <path d="M12 12.5 19 18.5" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" opacity="0.85" />
            <circle cx="12" cy="5" r="2" fill="#fff" opacity="0.85" />
            <circle cx="5" cy="18.5" r="2" fill="#fff" opacity="0.85" />
            <circle cx="19" cy="18.5" r="2" fill="#fff" opacity="0.85" />
            <circle cx="12" cy="12.5" r="2.7" fill="#fff" />
          </svg>
          <div style={{ display: "flex", fontSize: "52px", fontWeight: 700, letterSpacing: "-0.02em" }}>
            SpanoAI
          </div>
        </div>

        {/* headline + pillars */}
        <div style={{ display: "flex", flexDirection: "column", gap: "22px" }}>
          <div
            style={{
              display: "flex",
              fontSize: "62px",
              fontWeight: 700,
              lineHeight: 1.1,
              letterSpacing: "-0.03em",
              maxWidth: "950px",
            }}
          >
            Shared memory &amp; a message bus for multi-agent systems
          </div>
          <div style={{ display: "flex", fontSize: "30px", color: "#a1a1aa" }}>
            Context store · Message bus · Audit log
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
