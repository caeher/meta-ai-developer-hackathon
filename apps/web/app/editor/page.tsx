import { redirect } from "next/navigation";
import { requireUser } from "../../server/auth/auth";

export default async function EditorEntryPage(): Promise<never> {
  await requireUser();
  redirect("/projects");
}
