import 'server-only';
import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
function key(){const encoded=process.env.TOKEN_ENCRYPTION_KEY;if(!encoded)throw new Error('TOKEN_ENCRYPTION_KEY chưa cấu hình.');const value=Buffer.from(encoded,'base64');if(value.length!==32)throw new Error('Khóa mã hóa phải đủ 32 byte.');return value;}
export function seal(value:unknown){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(),iv);const ciphertext=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),ciphertext]).toString('base64url');}
export function unseal<T>(token:string):T {const raw=Buffer.from(token,'base64url');if(raw.length<29)throw new Error('Invalid cookie');const decipher=createDecipheriv('aes-256-gcm',key(),raw.subarray(0,12));decipher.setAuthTag(raw.subarray(12,28));return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)),decipher.final()]).toString('utf8')) as T;}
export type DriveCredentials={uid:string;refreshToken:string;accessToken:string;expiresAt:number;email:string};
export type OAuthContext={uid:string;state:string;expiresAt:number};
