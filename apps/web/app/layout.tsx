import type { Metadata } from "next";
import { Theme } from "@radix-ui/themes";
import { AuthProvider } from "../components/auth/AuthProvider";
import { getClerkConfiguration } from "../server/auth/config";
import "@radix-ui/themes/styles.css";
import "../styles/tokens.css";
import "../styles/radix.css";
import "../styles/globals.css";

export const metadata: Metadata = {
  title: "Forja — juegos 2D",
  description: "Plataforma para crear juegos web 2D con ayuda de IA.",
};

export const dynamic = "force-dynamic";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const clerkConfiguration = getClerkConfiguration();

  return (
    <html lang="es">
      <body>
        <AuthProvider
          configured={clerkConfiguration.configured}
          publishableKey={process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY}
        >
          <Theme
            appearance="dark"
            accentColor="blue"
            grayColor="slate"
            hasBackground={false}
            panelBackground="solid"
            radius="medium"
          >
            {children}
          </Theme>
        </AuthProvider>
      </body>
    </html>
  );
}
