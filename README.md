# Agenda escolar

Aplicación sencilla para gestionar clases particulares y alumnos desde una interfaz web.

## Ejecutar localmente

```bash
npm install
npm run dev
```

Luego abrí http://localhost:3000.

## Despliegue en Vercel

1. Sube este proyecto a GitHub.
2. Conecta el repositorio en Vercel.
3. Vercel usará la función serverless en api/index.js y el servidor Express.
4. Si querés usar una base de datos remota en producción, podés reemplazar la base local por PostgreSQL usando una variable de entorno DATABASE_URL.
