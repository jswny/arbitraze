defmodule Arbitraze.Kalshi.KalshiWebSocketClient do
  @moduledoc false
  use GenServer

  require Logger

  def start_link(args) do
    GenServer.start_link(__MODULE__, args, name: __MODULE__)
  end

  def init(args) do
    host = Keyword.fetch!(args, :host)
    port = Keyword.fetch!(args, :port)
    path = Keyword.fetch!(args, :path)
    api_key = Keyword.fetch!(args, :api_key)
    private_key_pem = Keyword.fetch!(args, :private_key)

    ws_opts = Keyword.get(args, :ws_opts, %{})

    private_key =
      case parse_private_key(private_key_pem) do
        {:ok, key} ->
          key

        {:error, reason} ->
          raise "Failed to parse private key: #{inspect(reason)}"
      end

    keepalive_seconds = 10

    connect_opts = %{
      connect_timeout: to_timeout(minute: 1),
      retry: 10,
      retry_timeout: 100,
      protocols: [:http],
      transport: :tls,
      tls_opts: [
        # TODO: For development only, enable proper verification in production
        verify: :verify_none
      ],
      ws_opts: %{
        keepalive: to_timeout(second: keepalive_seconds)
      }
    }

    {:ok, conn_pid} = :gun.open(host, port, connect_opts)

    case :gun.await_up(conn_pid) do
      {:ok, protocol} ->
        Logger.info("Connection established with protocol: #{protocol}")

        timestamp = :os.system_time(:millisecond)
        timestamp_str = Integer.to_string(timestamp)
        message = timestamp_str <> "GET" <> path

        {:ok, signature} = sign_message(private_key, message)

        headers =
          Map.get(ws_opts, :headers, []) ++
            [
              {"KALSHI-ACCESS-KEY", api_key},
              {"KALSHI-ACCESS-SIGNATURE", signature},
              {"KALSHI-ACCESS-TIMESTAMP", timestamp_str},
              {"Content-Type", "application/json"}
            ]

        stream_ref = :gun.ws_upgrade(conn_pid, path, headers)

        case await_ws_upgrade(conn_pid, stream_ref) do
          {:ok, :upgraded} ->
            {:ok,
             %{
               conn_pid: conn_pid,
               stream_ref: stream_ref,
               api_key: api_key,
               private_key: private_key,
               path: path,
               tickers: [],
               command_id: 1
             }}

          {:error, reason, details} ->
            Logger.error("WebSocket upgrade failed: #{inspect(reason)}, details: #{inspect(details)}")

            :gun.close(conn_pid)
            {:stop, {:ws_upgrade_failed, reason, details}}
        end

      {:error, reason} ->
        Logger.error("Connection failed: #{inspect(reason)}")
        {:stop, {:connection_failed, reason}}
    end
  end

  defp parse_private_key(pem) do
    case :public_key.pem_decode(pem) do
      [] ->
        {:error, "Invalid PEM format or empty private key"}

      entries when is_list(entries) ->
        [entry | _] = entries
        private_key = :public_key.pem_entry_decode(entry)

        case private_key do
          {:RSAPrivateKey, _, _, _, _, _, _, _, _, _, _} ->
            {:ok, private_key}

          _other ->
            {:error, "Not an RSA private key"}
        end
    end
  rescue
    e ->
      {:error, e}
  catch
    _kind, reason ->
      {:error, reason}
  end

  defp sign_message(private_key, message) do
    msg = IO.iodata_to_binary(message)

    try do
      sig =
        :public_key.sign(
          msg,
          :sha256,
          private_key,
          [
            {:rsa_padding, :rsa_pkcs1_pss_padding},
            {:rsa_pss_saltlen, 32},
            {:rsa_mgf1_md, :sha256}
          ]
        )

      {:ok, Base.encode64(sig)}
    rescue
      _e ->
        {:error, :sign_failed}
    end
  end

  defp await_ws_upgrade(conn_pid, stream_ref) do
    receive do
      {:gun_upgrade, ^conn_pid, ^stream_ref, ["websocket"], _headers} ->
        Logger.info("WebSocket upgrade successful")
        {:ok, :upgraded}

      {:gun_response, ^conn_pid, ^stream_ref, _, status, _headers} ->
        Logger.error("WebSocket upgrade failed with status: #{status}")
        {:error, :ws_upgrade_failed, status}

      {:gun_error, ^conn_pid, ^stream_ref, reason} ->
        Logger.error("WebSocket upgrade failed with error: #{inspect(reason)}")
        {:error, :ws_upgrade_failed, reason}

      other ->
        Logger.debug("Unexpected message during WebSocket upgrade: #{inspect(other)}")
        await_ws_upgrade(conn_pid, stream_ref)
    after
      10_000 ->
        Logger.error("WebSocket upgrade timed out")
        {:error, :timeout}
    end
  end

  def send_message(message) do
    GenServer.call(__MODULE__, {:send, message})
  end

  def get_connection do
    GenServer.call(__MODULE__, :get_connection)
  end

  def subscribe_to_ticker(ticker) do
    GenServer.cast(__MODULE__, {:subscribe_ticker, ticker})
  end

  def handle_call({:send, message}, _from, %{conn_pid: conn_pid, stream_ref: stream_ref, command_id: id} = state) do
    message =
      case message do
        %{} ->
          message = Map.put(message, "id", id)
          Jason.encode!(message)

        _ ->
          message
      end

    :gun.ws_send(conn_pid, stream_ref, {:text, message})
    {:reply, :ok, %{state | command_id: id + 1}}
  end

  def handle_call(:get_connection, _from, state) do
    {:reply, state, state}
  end

  def handle_cast({:subscribe_ticker, ticker}, %{conn_pid: conn_pid, stream_ref: stream_ref, command_id: id} = state) do
    subscribe_message =
      Jason.encode!(%{
        "id" => id,
        "cmd" => "subscribe",
        "params" => %{
          "channels" => ["ticker"],
          "market_tickers" => [ticker]
        }
      })

    Logger.info("Subscribing to ticker: #{ticker}")
    :gun.ws_send(conn_pid, stream_ref, {:text, subscribe_message})
    {:noreply, %{state | command_id: id + 1}}
  end

  def handle_info({:gun_ws, conn_pid, _stream_ref, {:text, data}}, %{conn_pid: conn_pid} = state) do
    Logger.info("Received message: #{data}")
    {:noreply, state}
  end

  def handle_info({:gun_ws, conn_pid, _stream_ref, {:binary, data}}, %{conn_pid: conn_pid} = state) do
    Logger.info("Received binary data: #{inspect(data)}")
    {:noreply, state}
  end

  def handle_info({:gun_down, conn_pid, _protocol, reason, _killed_streams}, %{conn_pid: conn_pid} = state) do
    Logger.warning("WebSocket connection down: #{inspect(reason)}")
    {:noreply, state}
  end

  def handle_info({:gun_up, conn_pid, protocol}, %{conn_pid: conn_pid} = state) do
    Logger.info("Connection established with protocol: #{protocol}")
    {:noreply, state}
  end

  def handle_info(:send_ping, %{conn_pid: conn_pid, stream_ref: stream_ref} = state) do
    Logger.debug("Sending ping to server")
    :gun.ws_send(conn_pid, stream_ref, :ping)
    {:noreply, state}
  end

  def terminate(_reason, %{conn_pid: conn_pid}) do
    :gun.close(conn_pid)
  end
end
