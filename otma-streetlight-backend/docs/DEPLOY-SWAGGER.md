# Publishing the OTMA Swagger UI for free

The Swagger UI is a static site. It is already assembled in this `docs/` folder:

- `index.html` — branded Swagger UI shell.
- `openapi.yaml` — OpenAPI 3.1 contract loaded by Swagger UI.
- `.nojekyll` — GitHub Pages compatibility file.

## Preview locally

From the backend folder:

```powershell
python -m http.server 8080 --directory docs
```

Open `http://localhost:8080/`.

## Publish with GitHub Pages

If the entire `OTMA-Streetlight-Portal` directory is the root of a GitHub repository:

1. The combined project ZIP already includes `.github/workflows/deploy-otma-swagger.yml` at the repository root. If you extracted only the backend ZIP, copy `deployment-templates/deploy-swagger-pages.yml` to that root workflow path.
2. Push the project to a GitHub repository on the `main` branch.
3. In GitHub, open **Settings → Pages** and choose **GitHub Actions** as the build/deployment source.
4. The workflow publishes `otma-streetlight-backend/docs` as a static Pages site.
5. The GitHub Pages URL is shown under **Settings → Pages** after the first successful run.

GitHub Pages can host a public API reference on an eligible public repository under GitHub Free. The OpenAPI file contains the API contract, not secrets or live records. Keep it that way.

## Alternative: publish under the Vercel frontend

During frontend integration, copy the content of this `docs/` folder into `otma-streetlight-homepage/api-docs/`. Vercel will then serve the Swagger UI at `/api-docs/` alongside the portal. Keep the spec URL relative (`./openapi.yaml`).

## Configure the server

After Supabase functions are deployed, replace `YOUR_PROJECT_REF` in `openapi/openapi.yaml` with the Supabase project reference, then copy that file to `docs/openapi.yaml`. Or change the server selector in Swagger UI to your deployed function base URL.

For staff endpoints, obtain a short-lived access token by signing in with an authorized staff user and use Swagger's **Authorize** dialog. Enter the Supabase publishable key in `PublishableKey` and the staff access token in `StaffBearer`. Do not paste a service-role/secret key into Swagger UI or publish it in the OpenAPI file.

Browser **Try it out** requests must originate from an origin listed in Supabase's `ALLOWED_ORIGINS` secret. Add the exact Pages domain to that secret before testing from the public docs URL.
