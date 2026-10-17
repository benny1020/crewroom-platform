if (
  document.querySelector('meta[name="crewroom-runtime"]')?.content === "server"
) {
  await import("./live-app.js");
} else {
  await import("./app.js");
}
