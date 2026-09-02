declare module "#start-handler" {
  const handler: {
    fetch: (request: Request) => Response | Promise<Response>;
  };
  export default handler;
}
