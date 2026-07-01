export default function GlobalNotFound() {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          background: "#0b0f19",
          color: "#e5e7eb",
          fontFamily:
            'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        }}
      >
        <main style={{ textAlign: "center", padding: "2rem" }}>
          <p
            style={{
              margin: 0,
              fontSize: "0.875rem",
              letterSpacing: "0.2em",
              textTransform: "uppercase",
              color: "#94a3b8",
            }}
          >
            404
          </p>
          <h1
            style={{
              margin: "0.75rem 0 0",
              fontSize: "clamp(2rem, 5vw, 4rem)",
              lineHeight: 1.05,
            }}
          >
            Page not found
          </h1>
          <p
            style={{ margin: "1rem 0 0", maxWidth: "32rem", color: "#cbd5e1" }}
          >
            The page you requested does not exist in the SpanoAI dashboard.
          </p>
        </main>
      </body>
    </html>
  );
}
