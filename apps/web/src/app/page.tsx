import { redirect } from "next/navigation";

// F0: la app arranca siempre en la bóveda. El dashboard llega en F1.
export default function Home() {
  redirect("/unlock");
}
