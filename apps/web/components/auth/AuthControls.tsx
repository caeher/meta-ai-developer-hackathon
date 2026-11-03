"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button, DropdownMenu, Flex, Text } from "@radix-ui/themes";
import { useToast } from "../ui/toast";

type SessionUser = { userId: string; email: string };

export function AuthControls() {
  const router = useRouter();
  const { toast } = useToast();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    fetch("/api/auth/session", { cache: "no-store", credentials: "same-origin" })
      .then((response) => response.json())
      .then((result: { user?: SessionUser | null }) => { if (active) setUser(result.user ?? null); })
      .catch(() => { if (active) setUser(null); })
      .finally(() => { if (active) setLoaded(true); });
    return () => { active = false; };
  }, []);

  async function signOut(allSessions = false) {
    try {
      const response = await fetch(`/api/auth/${allSessions ? "logout-all" : "logout"}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!response.ok) throw new Error("logout_failed");
      setUser(null);
      toast({ tone: "ok", title: allSessions ? "Sesiones cerradas en todos los dispositivos." : "Sesión cerrada." });
      router.push("/sign-in");
      router.refresh();
    } catch {
      toast({ tone: "error", title: "No se pudo cerrar la sesión. Inténtalo de nuevo." });
    }
  }

  if (!loaded || !user) {
    return (
      <Flex align="center" gap="3">
        <Button asChild variant="soft"><Link href="/sign-in">Iniciar sesión</Link></Button>
        <Button asChild><Link href="/sign-up">Crear cuenta</Link></Button>
      </Flex>
    );
  }

  const initials = user.email.split("@")[0]?.split(/[._-]/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "U";
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        <Button variant="soft" aria-label={`Menú de ${user.email}`}>
          <span className="avatar-initials" aria-hidden="true">{initials}</span>
          <Text size="2">{user.email}</Text>
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end">
        <DropdownMenu.Label>{user.email}</DropdownMenu.Label>
        <DropdownMenu.Separator />
        <DropdownMenu.Item onSelect={() => void signOut()}>Cerrar sesión</DropdownMenu.Item>
        <DropdownMenu.Item color="red" onSelect={() => void signOut(true)}>Cerrar todas las sesiones</DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}
