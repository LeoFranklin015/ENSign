export default function Page() {
  return (
    <main style={{ fontFamily: "system-ui", padding: "2rem", maxWidth: "640px" }}>
      <h1 style={{ margin: 0, fontSize: "1.5rem" }}>ENSign Relay</h1>
      <p style={{ color: "#666" }}>Platform-paid registration + UserOp relay.</p>
      <ul style={{ fontFamily: "ui-monospace", fontSize: "0.85rem" }}>
        <li>GET /api/health</li>
        <li>POST /api/predict</li>
        <li>POST /api/register</li>
        <li>POST /api/relay</li>
      </ul>
    </main>
  );
}
