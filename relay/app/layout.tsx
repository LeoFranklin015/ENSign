export const metadata = {
  title: "ENSign Relay",
  description: "Platform-paid registration + UserOp relay for ENSign.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
