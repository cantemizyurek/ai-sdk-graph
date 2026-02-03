export function composeMiddleware<Ctx, R = void>(
  middlewares: Array<(ctx: Ctx, next: () => Promise<R>) => Promise<R>>,
  action: (ctx: Ctx) => Promise<R>
): (ctx: Ctx) => Promise<R> {
  return (ctx: Ctx) => {
    function dispatch(i: number): Promise<R> {
      if (i === middlewares.length) {
        return action(ctx)
      }

      return middlewares[i]!(ctx, () => dispatch(i + 1))
    }

    return dispatch(0)
  }
}
