"""Run the delegated Advisor HTTP receiver with explicit owning-service configuration."""
import os
import signal
from threading import Thread
from advisor_security.receiver import configured_server


def main():
    # Missing owner configuration remains fail closed.
    server=configured_server(
        issuer=os.environ['ADVISOR_DELEGATED_ISSUER'],
        jwks_url=os.environ['ADVISOR_DELEGATED_JWKS_URL'],
        membership_url=os.environ['CONTROL_PLANE_MEMBERSHIP_URL'],
        membership_service_token=os.environ['CONTROL_PLANE_MEMBERSHIP_SERVICE_TOKEN'],
        database_url=os.environ['ADVISOR_DATABASE_URL'],
        workflow_database_url=os.environ.get('ADVISOR_WORKFLOW_DATABASE_URL'),
        alerts_origin=os.environ.get("ADVISOR_ALERTS_ORIGIN"),
        alerts_service_token=os.environ.get("ADVISOR_ALERTS_SERVICE_TOKEN"),
        host=os.environ.get('ADVISOR_HTTP_HOST','127.0.0.1'),
        port=int(os.environ.get('ADVISOR_HTTP_PORT','8088')),
        allow_mesh_http=os.environ.get('ADVISOR_OWNER_MESH_MTLS') == 'true')
    def request_shutdown(_signum, _frame):
        # serve_forever() must be stopped from another thread.
        Thread(target=server.shutdown, name="advisor-http-shutdown", daemon=True).start()

    signal.signal(signal.SIGTERM, request_shutdown)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        request_shutdown(signal.SIGINT, None)
    finally:
        server.server_close()
        workflow_context=getattr(server,'workflow_context',None)
        if workflow_context is not None:
            workflow_context.__exit__(None,None,None)
        tracing=getattr(server,'advisor_tracing',None)
        if tracing is not None:
            tracing.shutdown()


if __name__=='__main__':main()
