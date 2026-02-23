export const metadata = { title: "ONLYOFFICE Editor" };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "Arial, sans-serif", background: "#f6f7fb" }}>
        {children}
      </body>
    </html>
  );
}
