import { ImageResponse } from "next/og";

// Social link preview (1200×630) for every docs/landing route, with the logo
// and a short brand lockup so shared links reliably show the SpanoAI mark.
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
          justifyContent: "center",
          gap: "44px",
          background:
            "radial-gradient(circle at 20% 15%, rgba(59,130,246,0.22), transparent 28%), radial-gradient(circle at 80% 80%, rgba(14,165,233,0.14), transparent 25%), linear-gradient(135deg, #09090b 0%, #10131a 100%)",
          color: "#fafafa",
          padding: "84px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "28px" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: "132px",
              height: "132px",
              borderRadius: "36px",
              background: "rgba(255,255,255,0.06)",
              boxShadow: "0 0 0 1px rgba(255,255,255,0.08) inset",
            }}
          >
            <svg width="90" height="90" viewBox="0 0 24 24" fill="none">
              <path d="M12 5 5 18.5 19 18.5Z" stroke="#fff" strokeWidth="1.6" strokeLinejoin="round" opacity="0.4" />
              <path d="M12 12.5V5" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" opacity="0.85" />
              <path d="M12 12.5 5 18.5" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" opacity="0.85" />
              <path d="M12 12.5 19 18.5" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" opacity="0.85" />
              <circle cx="12" cy="5" r="2" fill="#fff" opacity="0.85" />
              <circle cx="5" cy="18.5" r="2" fill="#fff" opacity="0.85" />
              <circle cx="19" cy="18.5" r="2" fill="#fff" opacity="0.85" />
              <circle cx="12" cy="12.5" r="2.7" fill="#fff" />
            </svg>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <div style={{ display: "flex", fontSize: "58px", fontWeight: 750, letterSpacing: "-0.04em", lineHeight: 1 }}>
              SpanoAI
            </div>
            <div style={{ display: "flex", fontSize: "28px", color: "#a1a1aa", letterSpacing: "0.01em" }}>
              Shared context for multi-agent systems
            </div>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "18px", maxWidth: "980px" }}>
          <div
            style={{
              display: "flex",
              fontSize: "64px",
              fontWeight: 700,
              lineHeight: 1.08,
              letterSpacing: "-0.04em",
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
