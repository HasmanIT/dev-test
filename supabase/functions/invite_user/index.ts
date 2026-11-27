// Admin: creates a login (email + password, already confirmed) and a taker profile.
import { adminClient, parseBody, requireCaller, z } from "../_shared/auth.ts";
import { HttpError, serve } from "../_shared/http.ts";

const Body = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8).max(72),
  display_name: z.string().trim().min(1).max(80),
});

serve("invite_user", async (req, body) => {
  await requireCaller(req, ["admin"]);
  const input = parseBody(Body, body);
  const db = adminClient();

  const { data, error } = await db.auth.admin.createUser({
    email: input.email,
    password: input.password,
    email_confirm: true,
    user_metadata: { display_name: input.display_name },
  });
  if (error) {
    if (/already/i.test(error.message)) throw new HttpError(409, "a user with this email already exists");
    throw new HttpError(400, error.message);
  }
  // The on_auth_user_created trigger creates the taker profile.
  return { user_id: data.user.id, email: input.email };
});
