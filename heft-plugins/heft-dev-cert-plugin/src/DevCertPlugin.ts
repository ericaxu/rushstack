// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import type {
  HeftConfiguration,
  HeftSession,
  IBuildStageContext,
  IBundleSubstage,
  IHeftPlugin,
  IScopedLogger
} from '@rushstack/heft';
import { CertificateManager, ICertificate } from '@rushstack/debug-certificate-manager';

// IMPORTANT: To simplify versioning, 'webpack-dev-server' is a devDependency, not a regular dependency.
// Thus we must always use "import type" instead of "import" in this project.
import type { Configuration as WebpackDevServerConfig } from 'webpack-dev-server';

export interface IWebpackConfigPartial {
  devServer?: WebpackDevServerConfig;
}

const PLUGIN_NAME: string = 'heft-dev-cert-plugin';

/**
 * @internal
 */
export class DevCertPlugin implements IHeftPlugin {
  public readonly pluginName: string = PLUGIN_NAME;

  /**
   * Ensures a developer certificate exists and is configured for use by webpack-dev-server in serve mode.
   *
   * Registers two custom actions for manually controlling the development certificate
   * `heft trust-dev-cert` - creates and trusts a local development certificate for localhost
   * `heft untrust-dev-cert` - untrusts the local development certificate for localhost
   */
  public apply(heftSession: HeftSession, heftConfiguration: HeftConfiguration): void {
    const logger: IScopedLogger = heftSession.requestScopedLogger(PLUGIN_NAME);
    const certificateManager: CertificateManager = new CertificateManager();

    heftSession.registerAction<undefined>({
      actionName: 'trust-dev-cert',
      documentation: 'Creates and trusts a local development certificate for localhost',
      callback: async () => {
        try {
          await certificateManager.ensureCertificateAsync(true, logger.terminal);
          logger.terminal.writeLine('Done.');
        } catch (err) {
          logger.emitError(new Error(`Unable to generate or trust development certificate. Error: ${err}`));
        }
      }
    });

    heftSession.registerAction<undefined>({
      actionName: 'untrust-dev-cert',
      documentation: 'Untrusts the local development certificate for localhost',
      callback: async () => {
        try {
          await certificateManager.untrustCertificateAsync(logger.terminal);
          logger.terminal.writeLine('Done.');
        } catch (err) {
          logger.emitError(new Error(`Unable to untrust development certificate. Error: ${err}`));
        }
      }
    });

    heftSession.hooks.build.tap(PLUGIN_NAME, (build: IBuildStageContext) => {
      build.hooks.bundle.tap(PLUGIN_NAME, (bundleSubstage: IBundleSubstage) => {
        if (build.properties.serveMode) {
          bundleSubstage.hooks.afterConfigureWebpack.tapPromise(PLUGIN_NAME, async () => {
            await this._configureDevServerAsync(
              bundleSubstage.properties?.webpackConfiguration as IWebpackConfigPartial | undefined,
              certificateManager,
              logger,
              this._determineMajorVersion(bundleSubstage.properties.webpackDevServerVersion)
            );
          });
        }
      });
    });
  }

  private _determineMajorVersion(version?: string): number | undefined {
    if (version) {
      return parseInt(version);
    } else {
      return;
    }
  }

  private async _configureDevServerAsync(
    webpackConfiguration: IWebpackConfigPartial | undefined,
    certificateManager: CertificateManager,
    logger: IScopedLogger,
    webpackDevServerMajorVersion?: number
  ): Promise<void> {
    const certificate: ICertificate = await certificateManager.ensureCertificateAsync(true, logger.terminal);
    if (!webpackConfiguration) {
      logger.terminal.writeVerboseLine('No webpack configuration available to configure devServer.');
    } else {
      const { devServer: originalDevServer } = webpackConfiguration;
      const hostname: string | undefined = certificate.subjectAltNames?.[0];
      if (webpackDevServerMajorVersion && webpackDevServerMajorVersion === 4) {
        const client: WebpackDevServerConfig['client'] = originalDevServer?.client;
        if (hostname) {
          if (typeof client === 'object') {
            const { webSocketURL } = client;
            if (typeof webSocketURL === 'object') {
              originalDevServer!.client = {
                ...client,
                webSocketURL: {
                  ...webSocketURL,
                  hostname
                }
              };
            }
          }
        }
        webpackConfiguration.devServer = {
          ...originalDevServer,
          allowedHosts: certificate.subjectAltNames as string[],
          server: {
            type: 'https',
            options: {
              minVersion: 'TLSv1.3',
              key: certificate.pemKey,
              cert: certificate.pemCertificate,
              ca: certificate.pemCaCertificate
            }
          }
        };
      } else {
        webpackConfiguration.devServer = {
          ...originalDevServer,
          https: {
            key: certificate.pemKey,
            cert: certificate.pemCertificate,
            ca: certificate.pemCaCertificate
          }
        };
      }
    }
  }
}
