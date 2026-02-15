export const metadata = {
  title: "Identity V Game Server Ping Checker",
  description:
    "Measure latency to Identity V game servers from your browser. Supports Asia, China domestic, NA-EU, and test servers.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
        <style
          dangerouslySetInnerHTML={{
            __html: `
              @media (max-width: 600px) {
                .grid {
                  grid-template-columns: 1fr !important;
                }
                .title {
                  font-size: 18px !important;
                  line-height: 1.3;
                }
                .subtitle {
                  font-size: 12px !important;
                  margin: 8px 0 14px 0 !important;
                }
                .header {
                  margin-bottom: 24px !important;
                  padding-bottom: 20px !important;
                }
                .header-actions {
                  flex-wrap: wrap;
                  gap: 8px !important;
                }
                .scan-btn,
                .lang-btn {
                  font-size: 12px !important;
                  padding: 9px 12px !important;
                }
                .container {
                  padding: 16px 12px !important;
                }
                .server-row {
                  flex-direction: column;
                  align-items: flex-start !important;
                  gap: 8px !important;
                  padding: 8px 10px !important;
                }
                .server-info {
                  width: 100%;
                  min-width: 0 !important;
                }
                .ping-section {
                  min-width: 0 !important;
                  width: 100%;
                  justify-content: flex-start !important;
                }
                .geo-info {
                  display: none !important;
                }
                .stats-bar {
                  flex-wrap: wrap;
                  gap: 12px !important;
                }
              }
            `,
          }}
        />
      </head>
      <body style={{ margin: 0, padding: 0 }}>{children}</body>
    </html>
  );
}
