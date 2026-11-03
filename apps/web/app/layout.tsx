import type { Metadata } from "next";
import { Theme } from "@radix-ui/themes";
import "@radix-ui/themes/styles.css";
import "../styles/tokens.css";
import "../styles/radix.css";
import "../styles/globals.css";
import { ToastProvider } from "../components/ui/toast";

export const metadata: Metadata = {
  title: "Forja - juegos 2D",
  description: "Plataforma para crear juegos web 2D con ayuda de IA.",
};

export const dynamic = "force-dynamic";

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es">
      <body>
        <Theme appearance="dark" accentColor="blue" grayColor="slate" hasBackground={false} panelBackground="solid" radius="medium">
          <ToastProvider>{children}</ToastProvider>
        </Theme>
      </body>
    </html>
  );
}
