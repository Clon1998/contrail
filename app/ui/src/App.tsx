import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { commands } from "@/bindings";

export default function App() {
  const [name, setName] = useState("");
  const [greeting, setGreeting] = useState<string>();

  async function sayHello(event: FormEvent) {
    event.preventDefault();
    setGreeting(await commands.greet(name));
  }

  return (
    <main className="flex h-full flex-col items-center justify-center gap-4">
      <h1 className="text-3xl font-semibold tracking-tight">Contrail</h1>
      <p className="text-muted-foreground">Live logs for AWS ECS services.</p>
      <form className="flex gap-2" onSubmit={sayHello}>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
          aria-label="Name"
        />
        <Button type="submit">Say hello</Button>
      </form>
      {greeting && <p data-testid="greeting">{greeting}</p>}
    </main>
  );
}
