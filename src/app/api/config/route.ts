export const dynamic='force-dynamic';
export function GET(){return Response.json({supabaseUrl:process.env.NEXT_PUBLIC_SUPABASE_URL||'',supabaseKey:process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY||'',driveEnabled:!!(process.env.GOOGLE_CLIENT_ID&&process.env.GOOGLE_CLIENT_SECRET&&process.env.TOKEN_ENCRYPTION_KEY)},{headers:{'Cache-Control':'no-store'}});}
