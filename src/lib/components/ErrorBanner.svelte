<script lang="ts">
  interface Props {
    message: string | null;
    dismiss: () => void;
  }

  let { message, dismiss }: Props = $props();
</script>

{#if message}
  <div class="error-banner" role="alert">
    <span>{message}</span>
    <button type="button" onclick={dismiss}>Dismiss</button>
  </div>
{/if}
