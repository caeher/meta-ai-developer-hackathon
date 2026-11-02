import { SignIn } from "@clerk/nextjs";
import { ClerkSetupNotice } from "../../../components/auth/ClerkSetupNotice";
import { getClerkConfiguration } from "../../../server/auth/config";

export default function SignInPage() {
  if (!getClerkConfiguration().configured) {
    return (
      <main className="shell">
        <ClerkSetupNotice />
      </main>
    );
  }

  return (
    <main className="shell">
      <SignIn forceRedirectUrl="/editor" fallbackRedirectUrl="/editor" />
    </main>
  );
}
