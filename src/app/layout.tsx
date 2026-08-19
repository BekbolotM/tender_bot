import type { ReactNode } from "react";

export const metadata = {
  title: "Тендер-бот",
  description: "Telegram-бот для мониторинга тендерных площадок по ключевым словам",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body
        style={{
          fontFamily: "system-ui, -apple-system, sans-serif",
          maxWidth: 640,
          margin: "0 auto",
          padding: 24,
          lineHeight: 1.6,
        }}
      >
        {children}
      </body>
    </html>
  );
}
