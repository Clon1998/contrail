<script setup lang="ts">
const name = ref('')
const greeting = ref<string>()

async function sayHello() {
  greeting.value = await greet(name.value)
}
</script>

<template>
  <main class="flex min-h-screen flex-col items-center justify-center gap-4">
    <h1 class="text-3xl font-semibold tracking-tight">Contrail</h1>
    <p class="text-muted">Live logs for AWS ECS services.</p>
    <form class="flex gap-2" @submit.prevent="sayHello">
      <UInput v-model="name" placeholder="Your name" aria-label="Name" />
      <UButton type="submit" label="Say hello" />
    </form>
    <p v-if="greeting" data-testid="greeting">{{ greeting }}</p>
  </main>
</template>
