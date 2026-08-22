import { Controller, Get, Param, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { join, extname, normalize } from 'path';
import { readFile, access } from 'fs/promises';
import { constants } from 'fs';

const dashboardBasePath = (process.env.BASE_PATH ?? '').replace(/^\/+|\/+$/g, '');
const dashboardControllerPath = [dashboardBasePath, 'ui'].filter(Boolean).join('/');

/**
 * Controller for serving static UI dashboard files
 * Serves the monitoring dashboard from the /public directory
 */
@Controller(dashboardControllerPath)
export class DashboardController {
  private readonly publicPath: string;

  // MIME type mapping for common file extensions
  private readonly mimeTypes: Record<string, string> = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.eot': 'application/vnd.ms-fontobject',
  };

  constructor() {
    // Public directory is at the root of the project
    this.publicPath = join(process.cwd(), 'public');
  }

  /**
   * Serve the main dashboard HTML at the root path
   * GET /
   */
  @Get()
  public async serveDashboard(@Res() reply: FastifyReply): Promise<void> {
    const filePath = join(this.publicPath, 'index.html');

    try {
      await access(filePath, constants.R_OK);
      const content = await readFile(filePath, 'utf-8');
      reply.header('Content-Type', 'text/html; charset=utf-8').send(content);
    } catch (_error) {
      reply.code(404).send({ error: 'File not found' });
    }
  }

  /**
   * Serve CSS file
   * GET /styles.css
   */
  @Get('styles.css')
  public async serveStyles(@Res() reply: FastifyReply): Promise<void> {
    await this.serveFile('styles.css', reply, 'text/css');
  }

  /**
   * Serve JavaScript file
   * GET /app.js
   */
  @Get('app.js')
  public async serveScript(@Res() reply: FastifyReply): Promise<void> {
    await this.serveFile('app.js', reply, 'application/javascript');
  }

  /**
   * Serve any static file from the public directory
   * GET /:filename
   * This allows serving additional assets like images, fonts, etc.
   */
  @Get(':filename')
  public async serveStaticFile(
    @Param('filename') filename: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    // Prevent directory traversal attacks
    const normalizedFilename = normalize(filename).replace(/^(\.\.(\/|\\|$))+/, '');

    // Don't serve index.html, styles.css, or app.js through this route
    if (['index.html', 'styles.css', 'app.js'].includes(normalizedFilename)) {
      reply.code(404).send({ error: 'File not found' });
      return;
    }

    const ext = extname(normalizedFilename).toLowerCase();
    const contentType = this.mimeTypes[ext] || 'application/octet-stream';

    await this.serveFile(normalizedFilename, reply, contentType);
  }

  /**
   * Helper method to serve files from the public directory
   */
  private async serveFile(
    filename: string,
    reply: FastifyReply,
    contentType: string = 'text/html',
  ): Promise<void> {
    const filePath = join(this.publicPath, filename);

    try {
      await access(filePath, constants.R_OK);
      const content = await readFile(filePath, 'utf-8');
      reply.header('Content-Type', `${contentType}; charset=utf-8`).send(content);
    } catch (_error) {
      reply.code(404).send({ error: 'File not found' });
    }
  }
}
