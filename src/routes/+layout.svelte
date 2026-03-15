<script>
  import '../app.css';
  let { children } = $props();
</script>

<div class="game-container">
  {@render children()}
</div>

<style>
  .game-container {
    width: 100%;
    max-width: 500px;
    height: 100vh;
    height: 100dvh;
    margin: 0 auto;
    position: relative;
    overflow: hidden;
  }
</style>
