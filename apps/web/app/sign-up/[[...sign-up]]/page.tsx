import { SignUp } from "@clerk/nextjs";
import { ClerkSetupNotice } from "../../../components/auth/ClerkSetupNotice";
import { getClerkConfiguration } from "../../../server/auth/config";

export default function SignUpPage() {
  if (!getClerkConfiguration().configured) {
    return (
      <main className="shell">
        <ClerkSetupNotice />
      </main>
    );
  }

  return (
    <main className="shell">
      <SignUp forceRedirectUrl="/editor" fallbackRedirectUrl="/editor" />
    </main>
  );
}
