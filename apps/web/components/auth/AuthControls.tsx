"use client";

import { SignedIn, SignedOut, SignInButton, SignUpButton, UserButton } from "@clerk/nextjs";
import { Badge, Button, Flex, Text } from "@radix-ui/themes";

export function AuthControls({ configured }: { configured: boolean }) {
  if (!configured) {
    return <Badge color="orange" variant="soft">Autenticación sin configurar</Badge>;
  }

  return (
    <Flex align="center" gap="3">
      <SignedOut>
        <SignInButton mode="redirect" forceRedirectUrl="/editor" fallbackRedirectUrl="/editor">
          <Button variant="soft">Iniciar sesión</Button>
        </SignInButton>
        <SignUpButton mode="redirect" forceRedirectUrl="/editor" fallbackRedirectUrl="/editor">
          <Button>Crear cuenta</Button>
        </SignUpButton>
      </SignedOut>
      <SignedIn>
        <Text size="2">Sesión activa</Text>
        <UserButton />
      </SignedIn>
    </Flex>
  );
}
