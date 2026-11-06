import { redirect } from "next/navigation";

// El dashboard llega con los datos on-chain; mientras, la entrada es la bóveda.
export default function Home() {
  redirect("/unlock");
}
