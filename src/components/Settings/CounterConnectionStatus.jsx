import React, { useEffect, useState } from 'react';
import { getRemoteConfig } from '../../mobile/remoteConfig';
import { testHostConnection } from '../../mobile/remoteApi';

export default function CounterConnectionStatus() {
  const isElectron = typeof window !== 'undefined' && !!window.api?.chooseBackupFolder;
  const [connection, setConnection] = useState(null);

  useEffect(() => {
    let cancelled = false;
    let timer;

    async function refresh() {
      try {
        let config;
        if (isElectron) {
          config = await window.api.getSyncConfig();
        } else {
          const mobileConfig = getRemoteConfig();
          if (mobileConfig.mode === 'LOCAL') {
            if (!cancelled) setConnection(null);
            return;
          }
          config = {
            role: mobileConfig.mode === 'HOST_DEVICE' ? 'HOST' : 'CLIENT',
            hostIp: mobileConfig.hostIp,
            port: mobileConfig.hostPort,
            authToken: mobileConfig.authToken,
          };
        }

        if (config.role !== 'HOST' && config.role !== 'CLIENT') {
          if (!cancelled) setConnection(null);
          return;
        }

        if (config.role === 'HOST') {
          const status = await window.api.getSyncStatus();
          if (!cancelled) {
            setConnection({
              role: 'HOST',
              online: !!status.running,
              text: status.running ? 'Host online' : 'Host offline',
              detail: status.error || (status.running ? 'This device is sharing live counter data.' : 'The counter host service is not running.'),
            });
          }
        } else {
          try {
            const host = await testHostConnection(config.hostIp, config.port || '4001', config.authToken);
            if (!cancelled) {
              setConnection({
                role: 'CLIENT',
                online: true,
                text: 'Host connected',
                detail: `Connected to ${host.hotelName || 'the Host'} at ${config.hostIp}:${config.port || '4001'}.`,
              });
            }
          } catch (error) {
            if (!cancelled) {
              setConnection({
                role: 'CLIENT',
                online: false,
                text: 'Host disconnected',
                detail: error.message || 'Could not reach the Host counter.',
              });
            }
          }
        }
      } catch (error) {
        if (!cancelled) {
          setConnection({
            role: 'HOST',
            online: false,
            text: 'Counter status unavailable',
            detail: error.message || 'Could not read counter connection status.',
          });
        }
      } finally {
        if (!cancelled) timer = setTimeout(refresh, 12000);
      }
    }

    refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isElectron]);

  if (!connection) return null;
  return (
    <span
      className={`counter-connection-badge ${connection.online ? 'online' : 'offline'}`}
      title={connection.detail}
      aria-label={`${connection.text}. ${connection.detail}`}
      aria-live="polite"
    >
      <span className="counter-connection-dot" aria-hidden="true" />
      <span>{connection.text}</span>
    </span>
  );
}
